const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const notificationService = require('../services/notification.service');
const { t } = require('../i18n');

async function submitRating(req, res) {
  const orderId = req.params.orderId;
  const raterId = req.user.id;
  const { rating, comment } = req.body;

  const [order] = await db.query(
    `SELECT * FROM service_orders WHERE id = ? AND status IN ('COMPLETED', 'CANCELED')`,
    [orderId]
  );

  if (!order) {
    throw new AppError('Order not found or not eligible for rating', 404);
  }

  let ratedId;
  if (raterId === order.customer_id) {
    ratedId = order.provider_id;
  } else if (raterId === order.provider_id) {
    ratedId = order.customer_id;
  } else {
    throw new AppError('You are not part of this order', 403);
  }

  if (!ratedId) {
    throw new AppError('No user to rate', 400);
  }

  const existing = await db.query(
    'SELECT id FROM order_ratings WHERE order_id = ? AND rater_id = ?',
    [orderId, raterId]
  );

  if (existing.length > 0) {
    throw new AppError('You have already rated this order', 409);
  }

  await db.query(
    `INSERT INTO order_ratings (order_id, rater_id, rated_id, rating, comment)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, raterId, ratedId, rating, comment || null]
  );

  await db.query(
    `INSERT INTO user_rating_summary (user_id, average_rating, total_ratings, total_stars)
     VALUES (?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE
       total_ratings = total_ratings + 1,
       total_stars = total_stars + ?,
       average_rating = (total_stars + ?) / (total_ratings + 1)`,
    [ratedId, rating, rating, rating, rating]
  );

  const [summary] = await db.query(
    `SELECT AVG(rating) as avg_rating, COUNT(*) as count, SUM(rating) as total
     FROM order_ratings WHERE rated_id = ?`,
    [ratedId]
  );

  await db.query(
    `UPDATE user_rating_summary
     SET average_rating = ?, total_ratings = ?, total_stars = ?
     WHERE user_id = ?`,
    [summary.avg_rating || 0, summary.count || 0, summary.total || 0, ratedId]
  );

  const language = req.language || 'en';

  if (raterId === order.customer_id && order.provider_id) {
    try {
      await notificationService.sendToUser(order.provider_id, {
        title: t('notifications.newRatingFromCustomer.title', {}, language),
        body: t('notifications.newRatingFromCustomer.body', {}, language),
        data: Object.fromEntries(
          Object.entries({
            type: 'new_rating',
            order_id: orderId,
          }).map(([k, v]) => [k, v == null ? '' : String(v)])
        ),
      });
    } catch (err) {
      console.warn('Push notification (new rating) failed:', err.message);
    }
  }

  res.status(201).json({ message: t('messages.ratingSubmitted', {}, language) });
}

async function getUserRatings(req, res) {
  const userId = req.params.userId || req.user.id;

  const [summary] = await db.query(
    'SELECT * FROM user_rating_summary WHERE user_id = ?',
    [userId]
  );

  const ratings = await db.query(
    `SELECT r.*, u.full_name as rater_name, sc.name as service_name
     FROM order_ratings r
     JOIN users u ON u.id = r.rater_id
     JOIN service_orders so ON so.id = r.order_id
     JOIN service_categories sc ON sc.id = so.service_id
     WHERE r.rated_id = ?
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [userId]
  );

  res.json({ summary: summary || { average_rating: 0, total_ratings: 0 }, ratings });
}

module.exports = { submitRating, getUserRatings };