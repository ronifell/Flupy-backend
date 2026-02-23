const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const assignmentService = require('../services/assignment.service');
const notificationService = require('../services/notification.service');
const { buildFileUrl, parsePagination } = require('../utils/helpers');

/**
 * Create a new service order (Customer)
 */
async function createOrder(req, res) {
  const customerId = req.user.id;
  const {
    service_id, description, order_mode, latitude, longitude,
    address_id, address_text, scheduled_start, scheduled_end,
  } = req.body;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Insert order
    const [result] = await conn.execute(
      `INSERT INTO service_orders
        (customer_id, service_id, description, order_mode, latitude, longitude, address_id, address_text, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CREATED')`,
      [customerId, service_id, description, order_mode, latitude, longitude, address_id || null, address_text || null]
    );
    const orderId = result.insertId;

    // Handle photos if uploaded
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const url = buildFileUrl(req, file.filename);
        await conn.execute(
          `INSERT INTO order_media (order_id, uploaded_by, media_type, media_url, category)
           VALUES (?, ?, 'photo', ?, 'problem')`,
          [orderId, customerId, url]
        );
      }
    }

    // If scheduled, create appointment
    if (order_mode === 'SCHEDULED' && scheduled_start && scheduled_end) {
      await conn.execute(
        `INSERT INTO order_appointments (order_id, proposed_by, proposed_start, proposed_end, status)
         VALUES (?, 'customer', ?, ?, 'PROPOSED')`,
        [orderId, scheduled_start, scheduled_end]
      );
    }

    // Update status to SEARCHING
    await conn.execute(
      `UPDATE service_orders SET status = 'SEARCHING' WHERE id = ?`,
      [orderId]
    );

    await conn.commit();

    // Trigger assignment engine asynchronously
    assignmentService.assignProvider(orderId).catch((err) => {
      console.error(`Assignment failed for order ${orderId}:`, err.message);
    });

    res.status(201).json({
      message: 'Order created successfully',
      order_id: orderId,
      status: 'SEARCHING',
    });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Get orders for the authenticated user
 */
async function getOrders(req, res) {
  const userId = req.user.id;
  const role = req.user.role;
  const { status } = req.query;
  const { limit, offset } = parsePagination(req.query);

  let whereClause = role === 'customer'
    ? 'WHERE so.customer_id = ?'
    : 'WHERE so.provider_id = ?';
  const params = [userId];

  if (status) {
    whereClause += ' AND so.status = ?';
    params.push(status);
  }

  params.push(limit, offset);

  const orders = await db.query(
    `SELECT so.*, sc.name as service_name, sc.slug as service_slug,
            u_cust.full_name as customer_name,
            u_prov.full_name as provider_name,
            urs.average_rating as provider_rating
     FROM service_orders so
     JOIN service_categories sc ON sc.id = so.service_id
     JOIN users u_cust ON u_cust.id = so.customer_id
     LEFT JOIN users u_prov ON u_prov.id = so.provider_id
     LEFT JOIN user_rating_summary urs ON urs.user_id = so.provider_id
     ${whereClause}
     ORDER BY so.created_at DESC
     LIMIT ? OFFSET ?`,
    params
  );

  res.json({ orders });
}

/**
 * Get single order details
 */
async function getOrderById(req, res) {
  const orderId = req.params.id;
  const userId = req.user.id;

  const [order] = await db.query(
    `SELECT so.*, sc.name as service_name,
            u_cust.full_name as customer_name, u_cust.phone as customer_phone,
            u_prov.full_name as provider_name, u_prov.phone as provider_phone,
            urs_prov.average_rating as provider_rating, urs_prov.total_ratings as provider_total_ratings,
            urs_cust.average_rating as customer_rating
     FROM service_orders so
     JOIN service_categories sc ON sc.id = so.service_id
     JOIN users u_cust ON u_cust.id = so.customer_id
     LEFT JOIN users u_prov ON u_prov.id = so.provider_id
     LEFT JOIN user_rating_summary urs_prov ON urs_prov.user_id = so.provider_id
     LEFT JOIN user_rating_summary urs_cust ON urs_cust.user_id = so.customer_id
     WHERE so.id = ?`,
    [orderId]
  );

  if (!order) {
    throw new AppError('Order not found', 404);
  }

  // Authorization: only customer or assigned provider can view
  if (order.customer_id !== userId && order.provider_id !== userId) {
    throw new AppError('Access denied', 403);
  }

  // Get media
  const media = await db.query(
    'SELECT * FROM order_media WHERE order_id = ? ORDER BY created_at',
    [orderId]
  );

  // Get appointment info
  const appointments = await db.query(
    'SELECT * FROM order_appointments WHERE order_id = ? ORDER BY created_at DESC',
    [orderId]
  );

  // Get ratings
  const ratings = await db.query(
    `SELECT r.*, u.full_name as rater_name
     FROM order_ratings r
     JOIN users u ON u.id = r.rater_id
     WHERE r.order_id = ?`,
    [orderId]
  );

  res.json({ order, media, appointments, ratings });
}

/**
 * Provider accepts an assigned order
 */
async function acceptOrder(req, res) {
  const orderId = req.params.id;
  const providerId = req.user.id;

  const [order] = await db.query(
    'SELECT * FROM service_orders WHERE id = ? AND provider_id = ? AND status = ?',
    [orderId, providerId, 'ASSIGNED']
  );

  if (!order) {
    throw new AppError('Order not found or cannot be accepted', 404);
  }

  await db.query(
    `UPDATE service_orders SET status = 'ASSIGNED', assigned_at = NOW() WHERE id = ?`,
    [orderId]
  );

  // Notify customer
  notificationService.sendToUser(order.customer_id, {
    title: 'Provider Accepted',
    body: 'Your service provider has confirmed the order.',
    data: { type: 'order_accepted', order_id: orderId },
  });

  res.json({ message: 'Order accepted' });
}

/**
 * Provider starts working on order
 */
async function startOrder(req, res) {
  const orderId = req.params.id;
  const providerId = req.user.id;

  const [order] = await db.query(
    'SELECT * FROM service_orders WHERE id = ? AND provider_id = ? AND status = ?',
    [orderId, providerId, 'ASSIGNED']
  );

  if (!order) {
    throw new AppError('Order not found or cannot be started', 404);
  }

  await db.query(
    `UPDATE service_orders SET status = 'IN_PROGRESS', started_at = NOW() WHERE id = ?`,
    [orderId]
  );

  notificationService.sendToUser(order.customer_id, {
    title: 'Service Started',
    body: 'Your service provider has started working on your order.',
    data: { type: 'order_started', order_id: orderId },
  });

  res.json({ message: 'Order started', status: 'IN_PROGRESS' });
}

/**
 * Provider completes the order
 */
async function completeOrder(req, res) {
  const orderId = req.params.id;
  const providerId = req.user.id;

  const [order] = await db.query(
    'SELECT * FROM service_orders WHERE id = ? AND provider_id = ? AND status = ?',
    [orderId, providerId, 'IN_PROGRESS']
  );

  if (!order) {
    throw new AppError('Order not found or cannot be completed', 404);
  }

  await db.query(
    `UPDATE service_orders SET status = 'COMPLETED', completed_at = NOW() WHERE id = ?`,
    [orderId]
  );

  notificationService.sendToUser(order.customer_id, {
    title: 'Service Completed',
    body: 'Your service has been completed. Please rate your provider.',
    data: { type: 'order_completed', order_id: orderId },
  });

  res.json({ message: 'Order completed', status: 'COMPLETED' });
}

/**
 * Cancel an order (customer or provider)
 */
async function cancelOrder(req, res) {
  const orderId = req.params.id;
  const userId = req.user.id;
  const { cancel_reason } = req.body;

  const [order] = await db.query(
    `SELECT * FROM service_orders WHERE id = ? AND (customer_id = ? OR provider_id = ?)
     AND status IN ('CREATED','SEARCHING','ASSIGNED','IN_PROGRESS')`,
    [orderId, userId, userId]
  );

  if (!order) {
    throw new AppError('Order not found or cannot be canceled', 404);
  }

  await db.query(
    `UPDATE service_orders SET status = 'CANCELED', cancel_reason = ?, canceled_at = NOW() WHERE id = ?`,
    [cancel_reason || null, orderId]
  );

  // Notify the other party
  const notifyUserId = userId === order.customer_id ? order.provider_id : order.customer_id;
  if (notifyUserId) {
    notificationService.sendToUser(notifyUserId, {
      title: 'Order Canceled',
      body: 'An order has been canceled.',
      data: { type: 'order_canceled', order_id: orderId },
    });
  }

  res.json({ message: 'Order canceled', status: 'CANCELED' });
}

/**
 * Upload media for an order (before/after photos, evidence)
 */
async function uploadOrderMedia(req, res) {
  const orderId = req.params.id;
  const userId = req.user.id;
  const category = req.body.category || 'evidence';

  if (!req.files || req.files.length === 0) {
    throw new AppError('No files uploaded', 400);
  }

  const urls = [];
  for (const file of req.files) {
    const url = buildFileUrl(req, file.filename);
    await db.query(
      `INSERT INTO order_media (order_id, uploaded_by, media_type, media_url, category)
       VALUES (?, ?, 'photo', ?, ?)`,
      [orderId, userId, url, category]
    );
    urls.push(url);
  }

  res.json({ message: 'Media uploaded', urls });
}

/**
 * Get all service categories
 */
async function getServiceCategories(req, res) {
  const categories = await db.query(
    'SELECT * FROM service_categories WHERE is_active = 1 ORDER BY sort_order'
  );
  res.json({ categories });
}

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  acceptOrder,
  startOrder,
  completeOrder,
  cancelOrder,
  uploadOrderMedia,
  getServiceCategories,
};
