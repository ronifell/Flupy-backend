const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const assignmentService = require('../services/assignment.service');
const notificationService = require('../services/notification.service');
const { buildFileUrl, parsePagination } = require('../utils/helpers');
const { t } = require('../i18n');

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
      [customerId, service_id || null, description || null, order_mode || 'ASAP', latitude || null, longitude || null, address_id || null, address_text || null]
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

    // Note: Provider assignment is now manual - customer must search and approve providers

    const language = req.language || 'en';
    res.status(201).json({
      message: t('messages.orderCreated', {}, language),
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

  const role = req.user.role;

  // Authorization:
  // - Customer can view their own orders
  // - Provider can view assigned orders OR unassigned orders they're eligible for (found in search)
  let hasAccess = false;

  if (role === 'customer') {
    hasAccess = order.customer_id === userId;
  } else if (role === 'provider') {
    // Provider can view if:
    // 1. They are assigned to the order, OR
    // 2. Order is unassigned (provider_id IS NULL) and they offer the service
    if (order.provider_id === userId) {
      hasAccess = true;
    } else if (!order.provider_id) {
      // Check if provider offers this service
      // First get the provider profile ID from user ID
      const [profile] = await db.query(
        'SELECT id FROM provider_profiles WHERE user_id = ?',
        [userId]
      );
      
      if (profile) {
        // Then check if this provider offers the service
        const [providerService] = await db.query(
          'SELECT * FROM provider_services WHERE provider_id = ? AND service_id = ?',
          [profile.id, order.service_id]
        );
        hasAccess = !!providerService;
      }
    }
  }

  if (!hasAccess) {
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
 * Provider claims an unassigned order (found in search)
 * This assigns the order to the provider and changes status to ASSIGNED
 */
async function claimOrder(req, res) {
  const orderId = req.params.id;
  const providerId = req.user.id;

  // Get provider profile to verify they offer the service
  const [profile] = await db.query(
    'SELECT id FROM provider_profiles WHERE user_id = ?',
    [providerId]
  );

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  // Get the order and verify it's unassigned
  const [order] = await db.query(
    'SELECT * FROM service_orders WHERE id = ?',
    [orderId]
  );

  if (!order) {
    throw new AppError('Order not found', 404);
  }

  // Verify order is unassigned
  if (order.provider_id) {
    throw new AppError('Order is already assigned to another provider', 400);
  }

  // Verify order status allows claiming
  if (!['CREATED', 'SEARCHING'].includes(order.status)) {
    throw new AppError(`Cannot claim order with status: ${order.status}`, 400);
  }

  // Verify provider offers this service
  const [providerService] = await db.query(
    'SELECT * FROM provider_services WHERE provider_id = ? AND service_id = ?',
    [profile.id, order.service_id]
  );

  if (!providerService) {
    throw new AppError('You do not offer this service type', 403);
  }

  // Claim the order: assign provider and update status
  await db.query(
    `UPDATE service_orders 
     SET provider_id = ?, status = 'ASSIGNED', assigned_at = NOW() 
     WHERE id = ?`,
    [providerId, orderId]
  );

  // Notify customer
  const language = req.language || 'en';
  notificationService.sendToUser(order.customer_id, {
    title: t('notifications.providerClaimed.title', {}, language),
    body: t('notifications.providerClaimed.body', {}, language),
    data: { type: 'order_claimed', order_id: orderId },
  });

  res.json({ message: t('messages.orderClaimed', {}, language) });
}

/**
 * Provider accepts an assigned order
 * (The assignment engine sets status=ASSIGNED; the provider "accepting"
 *  explicitly confirms they will take the job.)
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

  // Confirm assigned_at timestamp if not already set
  if (!order.assigned_at) {
    await db.query(
      `UPDATE service_orders SET assigned_at = NOW() WHERE id = ?`,
      [orderId]
    );
  }

  // Notify customer
  const language = req.language || 'en';
  notificationService.sendToUser(order.customer_id, {
    title: t('notifications.providerAccepted.title', {}, language),
    body: t('notifications.providerAccepted.body', {}, language),
    data: { type: 'order_accepted', order_id: orderId },
  });

  res.json({ message: t('messages.orderAccepted', {}, language) });
}

/**
 * Provider declines an assigned order → triggers reassignment
 */
async function declineOrder(req, res) {
  const orderId = req.params.id;
  const providerId = req.user.id;

  const [order] = await db.query(
    'SELECT * FROM service_orders WHERE id = ? AND provider_id = ? AND status = ?',
    [orderId, providerId, 'ASSIGNED']
  );

  if (!order) {
    throw new AppError('Order not found or cannot be declined', 404);
  }

  // Reset order for reassignment
  await db.query(
    `UPDATE service_orders SET provider_id = NULL, status = 'SEARCHING', assigned_at = NULL WHERE id = ?`,
    [orderId]
  );

  // Deactivate existing conversation
  await db.query(
    `UPDATE order_conversations SET is_active = 0 WHERE order_id = ?`,
    [orderId]
  );

  // Record decline in assignment audit
  await db.query(
    `INSERT INTO order_assignment_attempts (order_id, attempt_number, search_radius_km, candidates_found, assigned_provider_id, result)
     VALUES (?, (SELECT COALESCE(MAX(a2.attempt_number),0)+1 FROM order_assignment_attempts a2 WHERE a2.order_id = ?), 0, 0, ?, 'DECLINED')`,
    [orderId, orderId, providerId]
  );

  // Notify customer
  const language = req.language || 'en';
  notificationService.sendToUser(order.customer_id, {
    title: t('notifications.providerReassignment.title', {}, language),
    body: t('notifications.providerReassignment.body', {}, language),
    data: { type: 'provider_declined', order_id: orderId },
  });

  // Trigger reassignment
  assignmentService.assignProvider(orderId).catch((err) => {
    console.error(`Reassignment failed for order ${orderId}:`, err.message);
  });

  res.json({ message: t('messages.orderDeclined', {}, language) });
}

/**
 * Customer approves a provider and starts the service
 * This assigns the provider and changes status to ASSIGNED, then immediately to IN_PROGRESS
 */
async function approveProvider(req, res) {
  const orderId = req.params.id;
  const customerId = req.user.id;
  const { provider_id } = req.body;

  if (!provider_id) {
    throw new AppError('Provider ID is required', 400);
  }

  // Get the order and verify it belongs to the customer
  const [order] = await db.query(
    'SELECT * FROM service_orders WHERE id = ? AND customer_id = ?',
    [orderId, customerId]
  );

  if (!order) {
    throw new AppError('Order not found', 404);
  }

  // Verify order is in SEARCHING or ASSIGNED status
  // SEARCHING: Customer searched and found providers
  // ASSIGNED: Provider claimed the order, customer can approve to start service
  if (!['SEARCHING', 'ASSIGNED'].includes(order.status)) {
    throw new AppError(`Cannot approve provider for order with status: ${order.status}`, 400);
  }
  
  // If order is ASSIGNED, verify the provider_id matches the one being approved
  if (order.status === 'ASSIGNED' && order.provider_id !== provider_id) {
    throw new AppError('Cannot approve a different provider. This order is already assigned to another provider.', 400);
  }

  // Verify provider exists and offers this service
  const [profile] = await db.query(
    'SELECT id FROM provider_profiles WHERE user_id = ?',
    [provider_id]
  );

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  const [providerService] = await db.query(
    'SELECT * FROM provider_services WHERE provider_id = ? AND service_id = ?',
    [profile.id, order.service_id]
  );

  if (!providerService) {
    throw new AppError('Provider does not offer this service', 400);
  }

  // Assign provider if not already assigned (for SEARCHING status)
  // If already ASSIGNED, skip this step as provider is already assigned
  if (order.status === 'SEARCHING') {
    await db.query(
      `UPDATE service_orders 
       SET provider_id = ?, status = 'ASSIGNED', assigned_at = NOW() 
       WHERE id = ?`,
      [provider_id, orderId]
    );
  }

  // Create or reactivate conversation
  const [existingConv] = await db.query(
    'SELECT id FROM order_conversations WHERE order_id = ?',
    [orderId]
  );

  if (existingConv) {
    // Update existing conversation
    await db.query(
      `UPDATE order_conversations 
       SET provider_id = ?, is_active = 1 
       WHERE order_id = ?`,
      [provider_id, orderId]
    );
  } else {
    // Create new conversation
    await db.query(
      `INSERT INTO order_conversations (order_id, customer_id, provider_id)
       VALUES (?, ?, ?)`,
      [orderId, customerId, provider_id]
    );
  }

  // Immediately start the service (customer approval = service start)
  await db.query(
    `UPDATE service_orders SET status = 'IN_PROGRESS', started_at = NOW() WHERE id = ?`,
    [orderId]
  );

  // Notify provider
  const language = req.language || 'en';
  notificationService.sendToUser(provider_id, {
    title: t('notifications.orderApproved.title', {}, language),
    body: t('notifications.orderApproved.body', {}, language),
    data: { type: 'order_approved', order_id: orderId },
  });

  res.json({ 
    message: t('messages.providerApproved', {}, language), 
    status: 'IN_PROGRESS' 
  });
}

/**
 * Search for nearby providers for an order
 */
async function searchNearbyProviders(req, res) {
  const orderId = req.params.id;
  const customerId = req.user.id;
  const { max_radius_km } = req.query;

  // Verify order belongs to customer
  const [order] = await db.query(
    'SELECT * FROM service_orders WHERE id = ? AND customer_id = ?',
    [orderId, customerId]
  );

  if (!order) {
    throw new AppError('Order not found', 404);
  }

  if (order.status !== 'SEARCHING') {
    throw new AppError('Can only search providers for orders in SEARCHING status', 400);
  }

  const providers = await assignmentService.searchNearbyProviders(
    orderId,
    max_radius_km ? parseInt(max_radius_km) : 20
  );

  res.json({ providers });
}

/**
 * Customer: search providers by name or city for a service category
 * Used on the "service type" screen before the order is created.
 *
 * Query params:
 * - service_id (required)
 * - q (optional): provider name or city substring
 * - latitude, longitude (optional): for location-based search
 * - radius_km (optional, default 20): max distance when using coordinates
 * - limit (optional, default 30)
 */
async function searchProvidersCatalog(req, res) {
  const customerId = req.user.id;
  const { service_id, q, latitude, longitude, radius_km, limit } = req.query;

  const serviceId = parseInt(service_id, 10);
  if (!serviceId || isNaN(serviceId)) {
    throw new AppError('service_id is required', 400);
  }

  const safeLimit = Math.min(parseInt(limit || '30', 10) || 30, 50);
  const search = (q || '').trim();
  const hasCoords = latitude != null && longitude != null && latitude !== '' && longitude !== '';
  const radius = parseFloat(radius_km || '20') || 20;
  const lat = hasCoords ? parseFloat(latitude) : null;
  const lng = hasCoords ? parseFloat(longitude) : null;

  if (hasCoords) {
    if (
      isNaN(lat) || isNaN(lng) ||
      lat < -90 || lat > 90 ||
      lng < -180 || lng > 180
    ) {
      throw new AppError('Invalid latitude or longitude values', 400);
    }
  }

  // Search providers that:
  // - are available, verified, active membership
  // - offer this service
  // - optionally match by provider name OR any saved address city (if q is provided)
  // - optionally are within radius of given coordinates (if latitude/longitude provided)
  //
  // We also include one representative city (MAX city) if present.
  const params = [serviceId, customerId];
  let whereQ = '';
  if (search) {
    whereQ = 'AND (u.full_name LIKE ? OR ua.city LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  let havingQ = '';
  if (hasCoords) {
    // Filter by distance when coordinates are available
    havingQ = 'HAVING distance_km IS NOT NULL AND distance_km <= ?';
    params.push(radius);
  }
  params.push(safeLimit);

  const rows = await db.query(
    `SELECT
      pp.user_id as provider_id,
      u.full_name as provider_name,
      u.phone as provider_phone,
      u.avatar_url,
      pp.profile_picture_url,
      pp.accreditation_tier,
      urs.average_rating,
      urs.total_ratings,
      MAX(ua.city) as city,
      ${
        hasCoords
          ? // Distance from provided coordinates to provider's current GPS or closest address
            `COALESCE(
               CASE 
                 WHEN pp.current_lat IS NOT NULL 
                   AND pp.current_lng IS NOT NULL 
                   AND pp.location_updated_at IS NOT NULL
                   AND pp.location_updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
                 THEN ST_Distance_Sphere(
                   POINT(pp.current_lng, pp.current_lat),
                   POINT(${lng}, ${lat})
                 ) / 1000
                 ELSE NULL
               END,
               (
                 SELECT MIN(ST_Distance_Sphere(
                   POINT(ua2.longitude, ua2.latitude),
                   POINT(${lng}, ${lat})
                 ) / 1000)
                 FROM user_addresses ua2
                 WHERE ua2.user_id = pp.user_id
               )
             )`
          : 'NULL'
      } as distance_km
     FROM provider_profiles pp
     JOIN users u ON u.id = pp.user_id
     JOIN provider_services ps ON ps.provider_id = pp.id AND ps.service_id = ?
     LEFT JOIN user_rating_summary urs ON urs.user_id = pp.user_id
     LEFT JOIN user_addresses ua ON ua.user_id = pp.user_id
     WHERE pp.is_available = 1
       AND pp.is_verified = 1
       AND pp.membership_status = 'active'
       AND pp.user_id != ?
       ${whereQ}
     GROUP BY
      pp.user_id, u.full_name, u.phone, u.avatar_url, pp.profile_picture_url,
      pp.accreditation_tier, urs.average_rating, urs.total_ratings
     ${havingQ}
     ORDER BY
      ${hasCoords ? 'distance_km ASC,' : ''}
      urs.average_rating DESC,
      urs.total_ratings DESC,
      u.full_name ASC
     LIMIT ?`,
    params
  );

  // Resolve profile picture URLs similarly to the matching logic used elsewhere:
  // provider_profiles.profile_picture_url → provider_documents latest approved profile pic → users.avatar_url
  const providers = await Promise.all(
    (rows || []).map(async (p) => {
      let avatarUrl = p.profile_picture_url || null;

      if (!avatarUrl) {
        const [doc] = await db.query(
          `SELECT document_url
           FROM provider_documents
           WHERE provider_id = (
             SELECT id FROM provider_profiles WHERE user_id = ?
           )
             AND is_profile_picture = 1
             AND status = 'approved'
           ORDER BY created_at DESC
           LIMIT 1`,
          [p.provider_id]
        );
        if (doc?.document_url) avatarUrl = doc.document_url;
      }

      if (!avatarUrl) avatarUrl = p.avatar_url;

      return {
        provider_id: p.provider_id,
        provider_name: p.provider_name,
        provider_phone: p.provider_phone,
        avatar_url: avatarUrl,
        accreditation_tier: p.accreditation_tier,
        average_rating: p.average_rating,
        total_ratings: p.total_ratings,
        city: p.city || null,
      };
    })
  );

  res.json({ providers });
}

/**
 * Provider starts working on order
 * DEPRECATED: Only customers can start services by approving a provider.
 * This endpoint is kept for backward compatibility but returns an error.
 */
async function startOrder(req, res) {
  const language = req.language || 'en';
  throw new AppError(
    'Only customers can start services. The service starts automatically when the customer approves you as the provider.',
    403
  );
}

/**
 * Provider completes the order
 */
async function completeOrder(req, res) {
  const orderId = req.params.id;
  const userId = req.user.id;

  // Get order and verify user has access (customer or provider)
  const [order] = await db.query(
    'SELECT * FROM service_orders WHERE id = ? AND (customer_id = ? OR provider_id = ?) AND status = ?',
    [orderId, userId, userId, 'IN_PROGRESS']
  );

  if (!order) {
    throw new AppError('Order not found or cannot be completed', 404);
  }

  await db.query(
    `UPDATE service_orders SET status = 'COMPLETED', completed_at = NOW() WHERE id = ?`,
    [orderId]
  );

  // Notify the other party
  const language = req.language || 'en';
  const notifyUserId = userId === order.customer_id ? order.provider_id : order.customer_id;
  if (notifyUserId) {
    notificationService.sendToUser(notifyUserId, {
      title: t('notifications.serviceCompleted.title', {}, language),
      body: t('notifications.serviceCompleted.body', {}, language),
      data: { type: 'order_completed', order_id: orderId },
    });
  }

  res.json({ message: t('messages.orderCompleted', {}, language), status: 'COMPLETED' });
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
  const language = req.language || 'en';
  const notifyUserId = userId === order.customer_id ? order.provider_id : order.customer_id;
  if (notifyUserId) {
    notificationService.sendToUser(notifyUserId, {
      title: t('notifications.orderCanceled.title', {}, language),
      body: t('notifications.orderCanceled.body', {}, language),
      data: { type: 'order_canceled', order_id: orderId },
    });
  }

  res.json({ message: t('messages.orderCanceled', {}, language), status: 'CANCELED' });
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

  const language = req.language || 'en';
  res.json({ message: t('messages.mediaUploaded', {}, language), urls });
}

/**
 * Get all service categories filtered by country
 * Country can be provided as query parameter or from authenticated user's profile
 * If no country is provided, defaults to 'DR'
 */
async function getServiceCategories(req, res) {
  let country = req.query.country;
  
  // If no country in query and user is authenticated, get from user profile
  if (!country && req.user) {
    const [user] = await db.query('SELECT country FROM users WHERE id = ?', [req.user.id]);
    if (user && user.country) {
      country = user.country;
    }
  }
  
  // Default to 'DR' if no country is provided
  if (!country) {
    country = 'DR';
  }
  
  const categories = await db.query(
    'SELECT * FROM service_categories WHERE is_active = 1 AND country = ? ORDER BY sort_order',
    [country]
  );
  res.json({ categories });
}

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  claimOrder,
  acceptOrder,
  declineOrder,
  approveProvider,
  searchProvidersCatalog,
  searchNearbyProviders,
  startOrder,
  completeOrder,
  cancelOrder,
  uploadOrderMedia,
  getServiceCategories,
};
