const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { buildFileUrl } = require('../utils/helpers');
const notificationService = require('../services/notification.service');

/**
 * Get provider profile
 */
async function getProfile(req, res) {
  const userId = req.user.id;

  const [profile] = await db.query(
    `SELECT pp.*, u.full_name, u.email, u.phone, u.avatar_url,
            urs.average_rating, urs.total_ratings
     FROM provider_profiles pp
     JOIN users u ON u.id = pp.user_id
     LEFT JOIN user_rating_summary urs ON urs.user_id = pp.user_id
     WHERE pp.user_id = ?`,
    [userId]
  );

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  // Get services
  const services = await db.query(
    `SELECT sc.id, sc.name, sc.slug, sc.icon_url
     FROM provider_services ps
     JOIN service_categories sc ON sc.id = ps.service_id
     WHERE ps.provider_id = ?`,
    [profile.id]
  );

  // Get documents
  const documents = await db.query(
    'SELECT id, document_type, document_url, status, created_at FROM provider_documents WHERE provider_id = ?',
    [profile.id]
  );

  res.json({ profile, services, documents });
}

/**
 * Update provider profile (bio, services)
 */
async function updateProfile(req, res) {
  const userId = req.user.id;
  const { bio, services } = req.body;

  const [profile] = await db.query(
    'SELECT id FROM provider_profiles WHERE user_id = ?',
    [userId]
  );

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  if (bio !== undefined) {
    await db.query('UPDATE provider_profiles SET bio = ? WHERE id = ?', [bio, profile.id]);
  }

  // Update services (replace all)
  if (services && Array.isArray(services)) {
    await db.query('DELETE FROM provider_services WHERE provider_id = ?', [profile.id]);
    for (const serviceId of services) {
      await db.query(
        'INSERT INTO provider_services (provider_id, service_id) VALUES (?, ?)',
        [profile.id, serviceId]
      );
    }
  }

  res.json({ message: 'Profile updated successfully' });
}

/**
 * Toggle availability (Available / Unavailable)
 */
async function toggleAvailability(req, res) {
  const userId = req.user.id;
  const { is_available } = req.body;

  await db.query(
    'UPDATE provider_profiles SET is_available = ? WHERE user_id = ?',
    [is_available ? 1 : 0, userId]
  );

  res.json({ message: `Availability set to ${is_available ? 'available' : 'unavailable'}` });
}

/**
 * Update provider GPS location
 */
async function updateLocation(req, res) {
  const userId = req.user.id;
  const { latitude, longitude } = req.body;

  if (latitude == null || longitude == null || latitude === '' || longitude === '') {
    throw new AppError('Latitude and longitude are required', 400);
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new AppError('Invalid latitude or longitude values', 400);
  }

  await db.query(
    'UPDATE provider_profiles SET current_lat = ?, current_lng = ?, location_updated_at = NOW() WHERE user_id = ?',
    [lat, lng, userId]
  );

  res.json({ message: 'Location updated' });
}

/**
 * Upload verification document
 */
async function uploadDocument(req, res) {
  const userId = req.user.id;
  const { document_type } = req.body;

  console.log(`[Upload Document] User ${userId} attempting to upload document`);
  console.log(`[Upload Document] Request body:`, req.body);
  console.log(`[Upload Document] File received:`, req.file ? {
    filename: req.file.filename,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
  } : 'No file');

  if (!req.file) {
    console.error(`[Upload Document] No file uploaded for user ${userId}`);
    throw new AppError('No file uploaded', 400);
  }

  const [profile] = await db.query(
    'SELECT id FROM provider_profiles WHERE user_id = ?',
    [userId]
  );

  if (!profile) {
    console.error(`[Upload Document] Provider profile not found for user ${userId}`);
    throw new AppError('Provider profile not found', 404);
  }

  const url = buildFileUrl(req, req.file.filename);

  await db.query(
    `INSERT INTO provider_documents (provider_id, document_type, document_url)
     VALUES (?, ?, ?)`,
    [profile.id, document_type || 'General', url]
  );

  console.log(`[Upload Document] Document uploaded successfully for user ${userId}, document_id: ${profile.id}, url: ${url}`);

  res.json({ message: 'Document uploaded', document_url: url });
}

/**
 * Respond to a scheduled appointment
 */
async function respondToAppointment(req, res) {
  const userId = req.user.id;
  const appointmentId = req.params.id;
  const { action, proposed_start, proposed_end, response_note } = req.body;

  // Find the appointment
  const [appointment] = await db.query(
    `SELECT oa.*, so.provider_id, so.customer_id
     FROM order_appointments oa
     JOIN service_orders so ON so.id = oa.order_id
     WHERE oa.id = ? AND so.provider_id = ?`,
    [appointmentId, userId]
  );

  if (!appointment) {
    throw new AppError('Appointment not found', 404);
  }

  if (action === 'accept') {
    await db.query(
      `UPDATE order_appointments SET status = 'CONFIRMED', responded_at = NOW(), response_note = ? WHERE id = ?`,
      [response_note || null, appointmentId]
    );

    // Notify customer
    notificationService.sendToUser(appointment.customer_id, {
      title: 'Appointment Confirmed',
      body: 'Your provider has confirmed the scheduled appointment.',
      data: { type: 'appointment_confirmed', order_id: appointment.order_id },
    });

    res.json({ message: 'Appointment confirmed' });

  } else if (action === 'reschedule') {
    if (!proposed_start || !proposed_end) {
      throw new AppError('proposed_start and proposed_end are required for reschedule', 400);
    }

    if (appointment.reschedule_count >= 3) {
      throw new AppError('Maximum reschedule attempts reached', 400);
    }

    // Create new appointment entry
    await db.query(
      `INSERT INTO order_appointments (order_id, proposed_by, proposed_start, proposed_end, status, reschedule_count)
       VALUES (?, 'provider', ?, ?, 'PROPOSED', ?)`,
      [appointment.order_id, proposed_start, proposed_end, appointment.reschedule_count + 1]
    );

    await db.query(
      `UPDATE order_appointments SET status = 'RESCHEDULE_REQUESTED', responded_at = NOW(), response_note = ? WHERE id = ?`,
      [response_note || null, appointmentId]
    );

    // Notify customer about reschedule
    notificationService.sendToUser(appointment.customer_id, {
      title: 'Reschedule Requested',
      body: 'Your provider has proposed a new time for the appointment.',
      data: { type: 'appointment_rescheduled', order_id: appointment.order_id },
    });

    res.json({ message: 'Reschedule proposed' });

  } else if (action === 'decline') {
    await db.query(
      `UPDATE order_appointments SET status = 'DECLINED', responded_at = NOW(), response_note = ? WHERE id = ?`,
      [response_note || null, appointmentId]
    );

    // Reset order status to SEARCHING so the assignment engine can pick it up
    await db.query(
      `UPDATE service_orders SET provider_id = NULL, status = 'SEARCHING', assigned_at = NULL WHERE id = ?`,
      [appointment.order_id]
    );

    // Deactivate existing conversation
    await db.query(
      `UPDATE order_conversations SET is_active = 0 WHERE order_id = ?`,
      [appointment.order_id]
    );

    // Notify customer
    notificationService.sendToUser(appointment.customer_id, {
      title: 'Provider Reassignment',
      body: 'Your provider could not take the scheduled appointment. We are finding a new one.',
      data: { type: 'appointment_declined', order_id: appointment.order_id },
    });

    // Trigger reassignment
    const assignmentService = require('../services/assignment.service');
    assignmentService.assignProvider(appointment.order_id).catch((err) => {
      console.error(`Reassignment failed for order ${appointment.order_id}:`, err.message);
    });

    res.json({ message: 'Appointment declined, reassignment triggered' });
  }
}

/**
 * Get provider's dashboard stats
 */
async function getDashboard(req, res) {
  const userId = req.user.id;

  const [stats] = await db.query(
    `SELECT
       COUNT(CASE WHEN status = 'ASSIGNED' THEN 1 END) as assigned_orders,
       COUNT(CASE WHEN status = 'IN_PROGRESS' THEN 1 END) as active_orders,
       COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_orders,
       COUNT(CASE WHEN status = 'CANCELED' THEN 1 END) as canceled_orders,
       COUNT(*) as total_orders
     FROM service_orders
     WHERE provider_id = ?`,
    [userId]
  );

  const [rating] = await db.query(
    'SELECT average_rating, total_ratings FROM user_rating_summary WHERE user_id = ?',
    [userId]
  );

  const [profile] = await db.query(
    'SELECT is_available, is_verified, membership_status FROM provider_profiles WHERE user_id = ?',
    [userId]
  );

  // Check if provider has pending documents
  const [documents] = await db.query(
    `SELECT COUNT(*) as count FROM provider_documents pd
     JOIN provider_profiles pp ON pp.id = pd.provider_id
     WHERE pp.user_id = ? AND pd.status = 'pending'`,
    [userId]
  );

  const profileData = profile || {};
  // Convert count to number (MySQL returns COUNT as string or BigInt)
  const pendingCount = Number(documents?.count || 0);
  profileData.has_pending_documents = pendingCount > 0;

  res.json({ stats, rating: rating || {}, profile: profileData });
}

module.exports = {
  getProfile,
  updateProfile,
  toggleAvailability,
  updateLocation,
  uploadDocument,
  respondToAppointment,
  getDashboard,
};
