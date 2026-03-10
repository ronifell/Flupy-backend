const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { buildFileUrl } = require('../utils/helpers');
const notificationService = require('../services/notification.service');
const { t } = require('../i18n');

/**
 * Helper function to automatically set is_available = 1 when provider is verified and has active membership
 * Can accept either provider_id (from provider_profiles.id) or user_id
 */
async function updateAvailabilityIfEligible(providerIdOrUserId, useUserId = false) {
  const query = useUserId
    ? 'SELECT id, is_verified, membership_status, is_available FROM provider_profiles WHERE user_id = ?'
    : 'SELECT id, is_verified, membership_status, is_available FROM provider_profiles WHERE id = ?';
  
  const [profile] = await db.query(query, [providerIdOrUserId]);

  if (!profile) return;

  const shouldBeAvailable = profile.is_verified === 1 && profile.membership_status === 'active';
  
  // Only update if status needs to change
  if (shouldBeAvailable && profile.is_available === 0) {
    await db.query(
      'UPDATE provider_profiles SET is_available = 1 WHERE id = ?',
      [profile.id]
    );
    console.log(`[Auto-Availability] Provider ${profile.id} automatically set to available (verified + active membership)`);
  } else if (!shouldBeAvailable && profile.is_available === 1) {
    // If they lose verification or membership, set to unavailable
    await db.query(
      'UPDATE provider_profiles SET is_available = 0 WHERE id = ?',
      [profile.id]
    );
    console.log(`[Auto-Availability] Provider ${profile.id} automatically set to unavailable (missing verification or membership)`);
  }
}

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

  const language = req.language || 'en';
  res.json({ message: t('messages.profileUpdatedProvider', {}, language) });
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

  const language = req.language || 'en';
  const status = is_available ? t('provider.available', {}, language) : t('provider.unavailable', {}, language);
  res.json({ message: t('messages.availabilitySet', { status }, language) });
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

  const language = req.language || 'en';
  res.json({ message: t('messages.locationUpdated', {}, language) });
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

  // Insert document
  await db.query(
    `INSERT INTO provider_documents (provider_id, document_type, document_url)
     VALUES (?, ?, ?)`,
    [profile.id, document_type || 'General', url]
  );

  // Auto-approve and verify in development/testing mode
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  if (isDevelopment) {
    // Auto-approve the document
    const [insertedDoc] = await db.query(
      `SELECT id FROM provider_documents 
       WHERE provider_id = ? AND document_url = ? 
       ORDER BY id DESC LIMIT 1`,
      [profile.id, url]
    );
    
    if (insertedDoc && insertedDoc.id) {
      await db.query(
        `UPDATE provider_documents 
         SET status = 'approved', reviewed_at = NOW() 
         WHERE id = ?`,
        [insertedDoc.id]
      );
      
      // Auto-verify the provider
      await db.query(
        `UPDATE provider_profiles 
         SET is_verified = 1 
         WHERE id = ?`,
        [profile.id]
      );
      
      // Auto-set availability if provider has active membership
      await updateAvailabilityIfEligible(profile.id);
      
      console.log(`[Upload Document] DEV MODE: Document auto-approved and provider ${userId} auto-verified`);
    }
  }

  console.log(`[Upload Document] Document uploaded successfully for user ${userId}, document_id: ${profile.id}, url: ${url}`);

  res.json({ 
    message: isDevelopment 
      ? 'Document uploaded and approved (dev mode)' 
      : 'Document uploaded for verification',
    document_url: url,
    auto_verified: isDevelopment 
  });
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
    const language = req.language || 'en';
    notificationService.sendToUser(appointment.customer_id, {
      title: t('notifications.appointmentConfirmed.title', {}, language),
      body: t('notifications.appointmentConfirmed.body', {}, language),
      data: { type: 'appointment_confirmed', order_id: appointment.order_id },
    });

    res.json({ message: t('messages.appointmentConfirmed', {}, language) });

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
    const language = req.language || 'en';
    notificationService.sendToUser(appointment.customer_id, {
      title: t('notifications.rescheduleRequested.title', {}, language),
      body: t('notifications.rescheduleRequested.body', {}, language),
      data: { type: 'appointment_rescheduled', order_id: appointment.order_id },
    });

    res.json({ message: t('messages.rescheduleProposed', {}, language) });

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
    const language = req.language || 'en';
    notificationService.sendToUser(appointment.customer_id, {
      title: t('notifications.providerReassignmentAppointment.title', {}, language),
      body: t('notifications.providerReassignmentAppointment.body', {}, language),
      data: { type: 'appointment_declined', order_id: appointment.order_id },
    });

    // Trigger reassignment
    const assignmentService = require('../services/assignment.service');
    assignmentService.assignProvider(appointment.order_id).catch((err) => {
      console.error(`Reassignment failed for order ${appointment.order_id}:`, err.message);
    });

    res.json({ message: t('messages.appointmentDeclined', {}, language) });
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

/**
 * Approve or reject provider verification document (Admin function)
 * When a document is approved, automatically set provider as verified if they have at least one approved document
 */
async function reviewDocument(req, res) {
  const documentId = req.params.id;
  const { status } = req.body; // 'approved' or 'rejected'

  if (!['approved', 'rejected'].includes(status)) {
    throw new AppError('Status must be "approved" or "rejected"', 400);
  }

  // Get document with provider info
  const [document] = await db.query(
    `SELECT pd.*, pp.user_id, pp.id as provider_profile_id
     FROM provider_documents pd
     JOIN provider_profiles pp ON pp.id = pd.provider_id
     WHERE pd.id = ?`,
    [documentId]
  );

  if (!document) {
    throw new AppError('Document not found', 404);
  }

  // Update document status
  await db.query(
    `UPDATE provider_documents 
     SET status = ?, reviewed_at = NOW() 
     WHERE id = ?`,
    [status, documentId]
  );

  // If approved, check if provider should be verified
  if (status === 'approved') {
    // Check if provider has at least one approved document
    const [approvedDocs] = await db.query(
      `SELECT COUNT(*) as count 
       FROM provider_documents 
       WHERE provider_id = ? AND status = 'approved'`,
      [document.provider_profile_id]
    );

    // Set provider as verified if they have at least one approved document
    if (approvedDocs[0].count > 0) {
      await db.query(
        `UPDATE provider_profiles 
         SET is_verified = 1 
         WHERE id = ?`,
        [document.provider_profile_id]
      );
      
      // Auto-set availability if provider has active membership
      await updateAvailabilityIfEligible(document.provider_profile_id);
      
      console.log(`[Review Document] Provider ${document.user_id} verified after document approval`);
    }
  } else {
    // If rejected, check if provider still has any approved documents
    const [approvedDocs] = await db.query(
      `SELECT COUNT(*) as count 
       FROM provider_documents 
       WHERE provider_id = ? AND status = 'approved'`,
      [document.provider_profile_id]
    );

    // Unverify provider if they have no approved documents
    if (approvedDocs[0].count === 0) {
      await db.query(
        `UPDATE provider_profiles 
         SET is_verified = 0 
         WHERE id = ?`,
        [document.provider_profile_id]
      );
      console.log(`[Review Document] Provider ${document.user_id} unverified - no approved documents`);
    }
  }

  const language = req.language || 'en';
  res.json({ 
    message: t('messages.documentStatus', { status }, language),
    provider_verified: status === 'approved' 
  });
}

module.exports = {
  getProfile,
  updateProfile,
  toggleAvailability,
  updateLocation,
  uploadDocument,
  respondToAppointment,
  getDashboard,
  reviewDocument,
  updateAvailabilityIfEligible, // Export helper for use in other controllers
};
