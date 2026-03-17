const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { buildFileUrl } = require('../utils/helpers');
const notificationService = require('../services/notification.service');
const { t } = require('../i18n');

/**
 * Helper function to check if provider has both required documents for verification
 * Returns { hasIdDocument: boolean, hasProfilePicture: boolean, canVerify: boolean }
 */
async function checkVerificationRequirements(providerId) {
  const allDocs = await db.query(
    `SELECT document_type, is_profile_picture, status 
     FROM provider_documents 
     WHERE provider_id = ? AND status = 'approved'`,
    [providerId]
  );
  
  // Ensure allDocs is an array
  const docsArray = Array.isArray(allDocs) ? allDocs : [];
  
  const hasIdDocument = docsArray.some(doc => 
    (doc.document_type === 'ID' || doc.document_type === 'General') && doc.is_profile_picture === 0
  );
  const hasProfilePicture = docsArray.some(doc => doc.is_profile_picture === 1);
  
  return {
    hasIdDocument,
    hasProfilePicture,
    canVerify: hasIdDocument && hasProfilePicture,
  };
}

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

  // Calculate and update accreditation tier if not set or needs upgrade (never downgrade)
  if (profile) {
    const calculatedTier = calculateAccreditationTier(profile.created_at, profile.is_verified === 1);
    const currentTierLevel = getTierLevel(profile.accreditation_tier);
    const calculatedTierLevel = getTierLevel(calculatedTier);
    
    // Only update if:
    // 1. Provider is verified but has no tier yet, OR
    // 2. Calculated tier is higher than current tier (upgrade only, never downgrade)
    if (calculatedTier && (calculatedTierLevel > currentTierLevel || (profile.is_verified === 1 && !profile.accreditation_tier))) {
      await db.query(
        'UPDATE provider_profiles SET accreditation_tier = ? WHERE id = ?',
        [calculatedTier, profile.id]
      );
      profile.accreditation_tier = calculatedTier;
    }
  }

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  // Get services
  const servicesResult = await db.query(
    `SELECT sc.id, sc.name, sc.slug, sc.icon_url
     FROM provider_services ps
     JOIN service_categories sc ON sc.id = ps.service_id
     WHERE ps.provider_id = ?`,
    [profile.id]
  );
  // Ensure services is an array
  const services = Array.isArray(servicesResult) ? servicesResult : [];

  // Get documents
  const documentsResult = await db.query(
    'SELECT id, document_type, document_url, status, is_profile_picture, created_at FROM provider_documents WHERE provider_id = ?',
    [profile.id]
  );
  // Ensure documents is an array
  const documents = Array.isArray(documentsResult) ? documentsResult : [];

  // Check verification requirements using helper function
  const verificationStatus = await checkVerificationRequirements(profile.id);
  
  // Ensure verification status is correct (fix any inconsistencies)
  if (profile.is_verified === 1 && !verificationStatus.canVerify) {
    // Provider is marked as verified but doesn't have both documents - fix it
    await db.query(
      'UPDATE provider_profiles SET is_verified = 0 WHERE id = ?',
      [profile.id]
    );
    profile.is_verified = 0;
    console.log(`[Get Profile] Fixed verification status for provider ${userId} - missing required documents`);
  } else if (profile.is_verified === 0 && verificationStatus.canVerify) {
    // Provider has both documents but isn't verified - fix it
    await db.query(
      'UPDATE provider_profiles SET is_verified = 1 WHERE id = ?',
      [profile.id]
    );
    profile.is_verified = 1;
    console.log(`[Get Profile] Fixed verification status for provider ${userId} - has both required documents`);
    
    // Assign iron badge if provider is verified but has no tier yet
    if (!profile.accreditation_tier) {
      const accreditationTier = calculateAccreditationTier(profile.created_at, true);
      if (accreditationTier) {
        await db.query(
          'UPDATE provider_profiles SET accreditation_tier = ? WHERE id = ?',
          [accreditationTier, profile.id]
        );
        profile.accreditation_tier = accreditationTier;
      }
    }
  }
  
  profile.verification_requirements = {
    has_id_document: verificationStatus.hasIdDocument,
    has_profile_picture: verificationStatus.hasProfilePicture,
    can_verify: verificationStatus.canVerify,
  };

  res.json({ profile, services, documents });
}

/**
 * Get tier level/rank for comparison (higher number = higher tier)
 * @param {string|null} tier - Accreditation tier
 * @returns {number} Tier level (0 = no tier, 1 = iron, 2 = 3_months, etc.)
 */
function getTierLevel(tier) {
  const tierLevels = {
    'iron': 1,
    '3_months': 2,
    '6_months': 3,
    '1_year': 4,
    '3_years': 5,
  };
  return tierLevels[tier] || 0;
}

/**
 * Calculate accreditation tier based on provider's activity duration
 * @param {Date|string} createdAt - Provider profile creation date
 * @param {boolean} isVerified - Whether provider is verified (default: false)
 * @returns {string|null} Accreditation tier or null
 */
function calculateAccreditationTier(createdAt, isVerified = false) {
  if (!createdAt) return null;
  
  const now = new Date();
  const created = new Date(createdAt);
  const monthsActive = (now - created) / (1000 * 60 * 60 * 24 * 30); // Approximate months
  
  if (monthsActive >= 36) return '3_years';
  if (monthsActive >= 12) return '1_year';
  if (monthsActive >= 6) return '6_months';
  if (monthsActive >= 3) return '3_months';
  // If verified but less than 3 months, assign iron badge
  if (isVerified) return 'iron';
  return null;
}

/**
 * Get service limit based on subscription plan
 */
function getServiceLimit(plan) {
  const limits = {
    basic: 1,
    professional: 3,
    premium: null, // null means unlimited
  };
  return limits[plan] || limits.basic;
}

/**
 * Update provider profile (bio, services)
 */
async function updateProfile(req, res) {
  const userId = req.user.id;
  const { bio, services } = req.body;

  const [profile] = await db.query(
    'SELECT id, subscription_plan, created_at FROM provider_profiles WHERE user_id = ?',
    [userId]
  );

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  if (bio !== undefined) {
    await db.query('UPDATE provider_profiles SET bio = ? WHERE id = ?', [bio, profile.id]);
  }

  // Update services (replace all) - enforce plan limits
  if (services && Array.isArray(services)) {
    // Get membership status to check if user has active subscription
    const [membershipInfo] = await db.query(
      'SELECT subscription_plan, membership_status FROM provider_profiles WHERE id = ?',
      [profile.id]
    );
    
    let plan = membershipInfo?.subscription_plan;
    // If plan is null but membership is active, treat as premium (unlimited) to avoid restrictions
    // This handles cases where subscription_plan wasn't set in the database
    if (!plan && membershipInfo?.membership_status === 'active') {
      plan = 'premium';
      console.warn(`[UpdateProfile] Provider ${profile.id} has active membership but subscription_plan is null, treating as premium`);
    }
    plan = plan || 'basic';
    
    const serviceLimit = getServiceLimit(plan);
    
    // Premium plan (null limit) has no restrictions
    if (serviceLimit !== null && services.length > serviceLimit) {
      const planNames = { basic: 'Basic', professional: 'Professional', premium: 'Premium' };
      throw new AppError(
        `Your ${planNames[plan] || 'Basic'} plan allows only ${serviceLimit} service categor${serviceLimit === 1 ? 'y' : 'ies'}. Please upgrade to select more services.`,
        400
      );
    }

    await db.query('DELETE FROM provider_services WHERE provider_id = ?', [profile.id]);
    for (const serviceId of services) {
      await db.query(
        'INSERT INTO provider_services (provider_id, service_id) VALUES (?, ?)',
        [profile.id, serviceId]
      );
    }
  }

  // Update accreditation tier (upgrade only, never downgrade)
  const [updatedProfile] = await db.query(
    'SELECT is_verified, accreditation_tier FROM provider_profiles WHERE id = ?',
    [profile.id]
  );
  const calculatedTier = calculateAccreditationTier(profile.created_at, updatedProfile?.is_verified === 1);
  const currentTierLevel = getTierLevel(updatedProfile?.accreditation_tier);
  const calculatedTierLevel = getTierLevel(calculatedTier);
  
  // Only update if calculated tier is higher than current tier (upgrade only, never downgrade)
  if (calculatedTier && calculatedTierLevel > currentTierLevel) {
    await db.query(
      'UPDATE provider_profiles SET accreditation_tier = ? WHERE id = ?',
      [calculatedTier, profile.id]
    );
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
  const isProfilePicture = req.body.is_profile_picture === 'true' || req.body.is_profile_picture === true;

  // Insert document
  await db.query(
    `INSERT INTO provider_documents (provider_id, document_type, document_url, is_profile_picture)
     VALUES (?, ?, ?, ?)`,
    [profile.id, document_type || (isProfilePicture ? 'Profile Picture' : 'ID'), url, isProfilePicture ? 1 : 0]
  );

  // If it's a profile picture, also update provider_profiles
  if (isProfilePicture) {
    await db.query(
      'UPDATE provider_profiles SET profile_picture_url = ? WHERE id = ?',
      [url, profile.id]
    );
  }

  // Auto-approve the document
  const [insertedDoc] = await db.query(
    `SELECT id FROM provider_documents 
     WHERE provider_id = ? AND document_url = ? 
     ORDER BY id DESC LIMIT 1`,
    [profile.id, url]
  );
  
  if (insertedDoc && insertedDoc.id) {
    // Auto-approve the document
    await db.query(
      `UPDATE provider_documents 
       SET status = 'approved', reviewed_at = NOW() 
       WHERE id = ?`,
      [insertedDoc.id]
    );
    
    // Check if provider has both ID document and profile picture for verification
    const verificationStatus = await checkVerificationRequirements(profile.id);
    
    // Auto-verify provider only if they have both ID and profile picture
    if (verificationStatus.canVerify) {
      await db.query(
        `UPDATE provider_profiles 
         SET is_verified = 1 
         WHERE id = ?`,
        [profile.id]
      );
      
      // Assign iron badge if provider is verified but has no tier yet
      const accreditationTier = calculateAccreditationTier(profile.created_at, true);
      if (accreditationTier) {
        await db.query(
          'UPDATE provider_profiles SET accreditation_tier = ? WHERE id = ?',
          [accreditationTier, profile.id]
        );
      }
      
      // Auto-set availability if provider has active membership
      await updateAvailabilityIfEligible(profile.id);
      
      console.log(`[Upload Document] Provider ${userId} verified (has both ID and profile picture)`);
    } else {
      // Ensure provider is NOT verified if they don't have both documents
      await db.query(
        `UPDATE provider_profiles 
         SET is_verified = 0 
         WHERE id = ?`,
        [profile.id]
      );
      
      console.log(`[Upload Document] Provider ${userId} needs both ID document and profile picture for verification (ID: ${verificationStatus.hasIdDocument}, Profile Picture: ${verificationStatus.hasProfilePicture})`);
    }
  }

  console.log(`[Upload Document] Document uploaded successfully for user ${userId}, document_id: ${profile.id}, url: ${url}`);

  // Check verification status
  const verificationCheck = await db.query(
    `SELECT 
       COUNT(CASE WHEN is_profile_picture = 0 AND status = 'approved' THEN 1 END) as id_docs,
       COUNT(CASE WHEN is_profile_picture = 1 AND status = 'approved' THEN 1 END) as profile_pics
     FROM provider_documents 
     WHERE provider_id = ?`,
    [profile.id]
  );

  // Get first row from result array
  const checkResult = Array.isArray(verificationCheck) && verificationCheck.length > 0 
    ? verificationCheck[0] 
    : { id_docs: 0, profile_pics: 0 };
  
  const isVerified = checkResult.id_docs > 0 && checkResult.profile_pics > 0;

  res.json({ 
    message: 'Document uploaded and approved',
    document_url: url,
    is_profile_picture: isProfilePicture,
    auto_verified: isVerified,
    verification_status: {
      has_id_document: checkResult.id_docs > 0,
      has_profile_picture: checkResult.profile_pics > 0,
      is_verified: isVerified,
    }
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
 * Search for customers/orders by proximity
 * Providers can search for orders based on their stored addresses or current GPS location
 */
async function searchCustomers(req, res) {
  const userId = req.user.id;
  const { latitude, longitude, radius_km = 20, service_id, status } = req.query;

  // Get provider profile to check services
  const [profile] = await db.query(
    'SELECT id, current_lat, current_lng, location_updated_at FROM provider_profiles WHERE user_id = ?',
    [userId]
  );

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  // Check if provider has any services configured
  const providerServices = await db.query(
    'SELECT service_id FROM provider_services WHERE provider_id = ?',
    [profile.id]
  );

  if (providerServices.length === 0) {
    console.log(`[Provider Search] User ${userId} (profile_id: ${profile.id}) has no services configured`);
    return res.json({ 
      orders: [], 
      message: 'No services configured. Please add services to your profile to search for orders.',
      search_location: null 
    });
  }

  // Convert service_ids to numbers for consistent comparison
  // MySQL may return them as strings, so ensure they're integers
  const serviceIds = providerServices.map(ps => {
    const id = typeof ps.service_id === 'string' ? parseInt(ps.service_id, 10) : ps.service_id;
    return id;
  }).filter(id => !isNaN(id));
  
  console.log(`[Provider Search] Provider ${userId} (profile_id: ${profile.id}) offers service IDs:`, serviceIds);
  console.log(`[Provider Search] Raw provider services from DB:`, providerServices);

  // Determine search location: prioritize GPS if recent, otherwise use provided coords or addresses
  let searchLat = latitude ? parseFloat(latitude) : null;
  let searchLng = longitude ? parseFloat(longitude) : null;
  let locationSource = 'provided';

  // If no coordinates provided, try to use current GPS location if recent (< 30 minutes)
  if ((!searchLat || !searchLng) && profile.current_lat && profile.current_lng && profile.location_updated_at) {
    const locationAge = Math.abs(new Date() - new Date(profile.location_updated_at)) / (1000 * 60); // minutes
    if (locationAge <= 30) {
      searchLat = parseFloat(profile.current_lat);
      searchLng = parseFloat(profile.current_lng);
      locationSource = 'gps';
    }
  }

  // If still no location, use provider's stored addresses
  if (!searchLat || !searchLng) {
    const addresses = await db.query(
      'SELECT latitude, longitude, is_default FROM user_addresses WHERE user_id = ? ORDER BY is_default DESC LIMIT 1',
      [userId]
    );

    if (addresses.length === 0) {
      throw new AppError('No location provided. Please set your address, use current location, or provide latitude/longitude.', 400);
    }

    searchLat = parseFloat(addresses[0].latitude);
    searchLng = parseFloat(addresses[0].longitude);
    locationSource = 'address';
  }

  // Validate coordinates
  if (isNaN(searchLat) || isNaN(searchLng) || searchLat < -90 || searchLat > 90 || searchLng < -180 || searchLng > 180) {
    throw new AppError('Invalid latitude or longitude values', 400);
  }

  const radius = parseFloat(radius_km) || 20;

  // Build query conditions
  let whereConditions = [
    'so.status IN (?, ?)', // Only search for CREATED or SEARCHING orders
    'so.provider_id IS NULL', // Not already assigned
    'so.latitude IS NOT NULL', // Ensure order has valid location
    'so.longitude IS NOT NULL',
    'ST_Distance_Sphere(POINT(so.longitude, so.latitude), POINT(?, ?)) / 1000 <= ?',
  ];
  // Parameters for WHERE conditions (status, distance calculation)
  let queryParams = ['CREATED', 'SEARCHING', searchLng, searchLat, radius];

  // Filter by service
  if (service_id) {
    const serviceId = parseInt(service_id);
    // Check if provider offers this service
    const offersService = serviceIds.includes(serviceId);
    
    if (offersService) {
      whereConditions.push('so.service_id = ?');
      queryParams.push(serviceId);
      console.log(`[Provider Search] Filtering by specific service_id: ${serviceId}`);
    } else {
      // Provider doesn't offer this service, return empty results
      console.log(`[Provider Search] Provider doesn't offer service_id ${serviceId}. Provider offers:`, serviceIds);
      return res.json({ 
        orders: [], 
        message: `You don't offer this service. Please add it to your profile.`,
        search_location: { latitude: searchLat, longitude: searchLng, radius_km: radius, source: locationSource } 
      });
    }
  } else {
    // Only show orders for services the provider offers
    if (serviceIds.length > 0) {
      whereConditions.push(`so.service_id IN (${serviceIds.map(() => '?').join(',')})`);
      queryParams.push(...serviceIds);
      console.log(`[Provider Search] Filtering by provider's services:`, serviceIds);
    } else {
      // No services configured (shouldn't reach here due to earlier check, but safety check)
      return res.json({ orders: [], message: 'No services configured.', search_location: null });
    }
  }

  // Filter by status if provided
  if (status) {
    whereConditions = whereConditions.filter(c => !c.includes('so.status'));
    whereConditions.push('so.status = ?');
    // Find and replace the status condition
    const statusIndex = queryParams.findIndex((p, i) => i < 2 && (p === 'CREATED' || p === 'SEARCHING'));
    if (statusIndex !== -1) {
      queryParams[statusIndex] = status;
    }
  }

  // Diagnostic: Check all available orders before filtering
  const allOrders = await db.query(
    `SELECT 
       so.id,
       so.status,
       so.provider_id,
       so.service_id,
       so.latitude,
       so.longitude,
       sc.name as service_name,
       ST_Distance_Sphere(
         POINT(so.longitude, so.latitude),
         POINT(?, ?)
       ) / 1000 AS distance_km
     FROM service_orders so
     JOIN service_categories sc ON sc.id = so.service_id
     WHERE so.latitude IS NOT NULL AND so.longitude IS NOT NULL
     ORDER BY so.created_at DESC
     LIMIT 10`,
    [searchLng, searchLat]
  );

  console.log(`[Provider Search] Diagnostic - All orders in system (first 10):`, allOrders.map(o => ({
    id: o.id,
    status: o.status,
    provider_id: o.provider_id,
    service_id: o.service_id,
    service_name: o.service_name,
    distance_km: o.distance_km?.toFixed(2),
    location: `${o.latitude}, ${o.longitude}`
  })));

  console.log(`[Provider Search] Provider ${userId} (profile_id: ${profile.id}) offers services:`, providerServices.map(ps => ps.service_id));
  console.log(`[Provider Search] Search conditions:`, {
    location: `${searchLat}, ${searchLng}`,
    radius_km: radius,
    service_filter: service_id ? `specific: ${service_id}` : `provider_services: [${providerServices.map(ps => ps.service_id).join(', ')}]`,
    status_filter: status || 'CREATED or SEARCHING',
    whereConditions: whereConditions
  });

  // Log the exact query and parameters for debugging
  console.log(`[Provider Search] Query params (${queryParams.length} params):`, queryParams);
  console.log(`[Provider Search] Final WHERE clause:`, whereConditions.join(' AND '));

  // Test query to verify orders exist with these conditions
  const testQuery = await db.query(
    `SELECT 
       so.id,
       so.status,
       so.provider_id,
       so.service_id,
       CASE WHEN so.status IN ('CREATED', 'SEARCHING') THEN 1 ELSE 0 END as status_match,
       CASE WHEN so.provider_id IS NULL THEN 1 ELSE 0 END as not_assigned,
       CASE WHEN so.service_id IN (${serviceIds.map(() => '?').join(',')}) THEN 1 ELSE 0 END as service_match
     FROM service_orders so
     WHERE so.latitude IS NOT NULL 
       AND so.longitude IS NOT NULL
       AND ST_Distance_Sphere(POINT(so.longitude, so.latitude), POINT(?, ?)) / 1000 <= ?
     ORDER BY so.created_at DESC
     LIMIT 5`,
    [...serviceIds, searchLng, searchLat, radius]
  );
  console.log(`[Provider Search] Test query results:`, testQuery);

  // Test query without JOINs to see if JOINs are the issue
  const testQueryNoJoins = await db.query(
    `SELECT
       so.id,
       so.status,
       so.provider_id,
       so.service_id,
       so.latitude,
       so.longitude
     FROM service_orders so
     WHERE ${whereConditions.join(' AND ')}
     LIMIT 5`,
    queryParams
  );
  console.log(`[Provider Search] Test query WITHOUT JOINs (should find orders 11 and 8):`, testQueryNoJoins);

  // Test if service_categories and users exist for these orders
  const testJoins = await db.query(
    `SELECT 
       so.id as order_id,
       so.service_id,
       so.customer_id,
       sc.id as category_exists,
       u.id as user_exists
     FROM service_orders so
     LEFT JOIN service_categories sc ON sc.id = so.service_id
     LEFT JOIN users u ON u.id = so.customer_id
     WHERE so.id IN (11, 8)`,
    []
  );
  console.log(`[Provider Search] JOIN test for orders 11 and 8:`, testJoins);

  // Build the complete parameter array for the main query
  // Parameters order: status (2), distance in WHERE (3), service_ids (N), distance in SELECT (2)
  const allParams = [...queryParams, searchLng, searchLat];
  console.log(`[Provider Search] All query parameters (${allParams.length} total):`, allParams);

  // Debug: Try the exact same query structure as the test query but with JOINs
  const debugQuery = await db.query(
    `SELECT
       so.id,
       so.status,
       so.provider_id,
       so.service_id,
       sc.id as category_id,
       u.id as user_id
     FROM service_orders so
     INNER JOIN service_categories sc ON sc.id = so.service_id
     INNER JOIN users u ON u.id = so.customer_id
     WHERE ${whereConditions.join(' AND ')}
     LIMIT 5`,
    queryParams
  );
  console.log(`[Provider Search] Debug query with JOINs (using queryParams only):`, debugQuery);

  // Execute search query
  // The debug query works with just queryParams, so the issue is the SELECT distance calculation
  // We'll calculate distance in the application instead of in SQL to avoid parameter binding issues
  const ordersRaw = await db.query(
    `SELECT
       so.id,
       so.description,
       so.status,
       so.order_mode,
       so.latitude,
       so.longitude,
       so.created_at,
       sc.id as service_id,
       sc.name as service_name,
       sc.slug as service_slug,
       u.id as customer_id,
       u.full_name as customer_name,
       u.phone as customer_phone
     FROM service_orders so
     INNER JOIN service_categories sc ON sc.id = so.service_id
     INNER JOIN users u ON u.id = so.customer_id
     WHERE ${whereConditions.join(' AND ')}
     ORDER BY so.created_at DESC
     LIMIT 50`,
    queryParams
  );

  // Calculate distance in JavaScript to avoid SQL parameter binding issues
  const orders = ordersRaw.map(order => {
    const orderLat = parseFloat(order.latitude);
    const orderLng = parseFloat(order.longitude);
    
    // Haversine formula for distance calculation
    const R = 6371; // Earth's radius in km
    const dLat = (orderLat - searchLat) * Math.PI / 180;
    const dLng = (orderLng - searchLng) * Math.PI / 180;
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(searchLat * Math.PI / 180) * Math.cos(orderLat * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance_km = R * c;
    
    return {
      ...order,
      distance_km: parseFloat(distance_km.toFixed(2))
    };
  }).sort((a, b) => {
    // Sort by distance first, then by creation date
    if (Math.abs(a.distance_km - b.distance_km) < 0.01) {
      return new Date(b.created_at) - new Date(a.created_at);
    }
    return a.distance_km - b.distance_km;
  });
  
  console.log(`[Provider Search] Query executed. Found ${orders.length} orders.`);
  if (orders.length > 0) {
    console.log(`[Provider Search] Sample order:`, {
      id: orders[0].id,
      status: orders[0].status,
      service_id: orders[0].service_id,
      service_name: orders[0].service_name,
      distance_km: orders[0].distance_km
    });
  } else {
    console.log(`[Provider Search] No orders found. Test query without JOINs found ${testQueryNoJoins.length} orders.`);
    console.log(`[Provider Search] Debug query with JOINs found ${debugQuery.length} orders.`);
  }

  console.log(`[Provider Search] User ${userId} found ${orders.length} orders within ${radius}km from ${locationSource} location (${searchLat}, ${searchLng})`);
  
  if (orders.length === 0 && allOrders.length > 0) {
    // Check why orders are being filtered out
    const serviceIds = providerServices.map(ps => ps.service_id);
    const matchingOrders = allOrders.filter(o => {
      const statusMatch = ['CREATED', 'SEARCHING'].includes(o.status);
      const notAssigned = o.provider_id === null;
      const serviceMatch = serviceIds.includes(o.service_id);
      const distanceMatch = o.distance_km <= radius;
      
      return { order_id: o.id, statusMatch, notAssigned, serviceMatch, distanceMatch, allMatch: statusMatch && notAssigned && serviceMatch && distanceMatch };
    });
    
    console.log(`[Provider Search] Diagnostic - Why orders are filtered:`, matchingOrders);
  }

  res.json({ 
    orders, 
    search_location: { 
      latitude: searchLat, 
      longitude: searchLng, 
      radius_km: radius,
      source: locationSource 
    } 
  });
}

/**
 * Approve or reject provider verification document (Admin function)
 * When a document is approved, automatically set provider as verified ONLY if they have BOTH ID document and profile picture approved
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

  // Check if provider has both ID document and profile picture for verification
  const verificationStatus = await checkVerificationRequirements(document.provider_profile_id);

  // Only verify if BOTH documents are present and approved
  if (verificationStatus.canVerify) {
    // Get provider profile to check created_at
    const [providerProfile] = await db.query(
      'SELECT created_at FROM provider_profiles WHERE id = ?',
      [document.provider_profile_id]
    );
    
    await db.query(
      `UPDATE provider_profiles 
       SET is_verified = 1 
       WHERE id = ?`,
      [document.provider_profile_id]
    );
    
    // Assign iron badge if provider is verified but has no tier yet
    if (providerProfile) {
      const accreditationTier = calculateAccreditationTier(providerProfile.created_at, true);
      if (accreditationTier) {
        await db.query(
          'UPDATE provider_profiles SET accreditation_tier = ? WHERE id = ?',
          [accreditationTier, document.provider_profile_id]
        );
      }
    }
    
    // Auto-set availability if provider has active membership
    await updateAvailabilityIfEligible(document.provider_profile_id);
    
    console.log(`[Review Document] Provider ${document.user_id} verified (has both ID and profile picture)`);
  } else {
    // Unverify provider if they don't have both documents
    await db.query(
      `UPDATE provider_profiles 
       SET is_verified = 0 
       WHERE id = ?`,
      [document.provider_profile_id]
    );
    
    console.log(`[Review Document] Provider ${document.user_id} unverified - missing required documents (ID: ${verificationStatus.hasIdDocument}, Profile Picture: ${verificationStatus.hasProfilePicture})`);
  }

  const language = req.language || 'en';
  res.json({ 
    message: t('messages.documentStatus', { status }, language),
    provider_verified: status === 'approved' 
  });
}

/**
 * Get public provider profile (for customers to view)
 */
async function getPublicProfile(req, res) {
  const providerId = req.params.id; // This is user_id, not provider_profile.id

  // Get provider profile by user_id
  const [profile] = await db.query(
    `SELECT pp.*, u.full_name, u.email, u.phone, u.avatar_url,
            urs.average_rating, urs.total_ratings
     FROM provider_profiles pp
     JOIN users u ON u.id = pp.user_id
     LEFT JOIN user_rating_summary urs ON urs.user_id = pp.user_id
     WHERE pp.user_id = ?`,
    [providerId]
  );

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  // Get profile picture from provider_profiles.profile_picture_url or provider_documents
  let profilePictureUrl = profile.profile_picture_url || null;
  
  // If not found in profile_picture_url, check documents
  if (!profilePictureUrl) {
    const [profilePictureDoc] = await db.query(
      `SELECT document_url 
       FROM provider_documents 
       WHERE provider_id = ? AND is_profile_picture = 1 AND status = 'approved' 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [profile.id]
    );
    if (profilePictureDoc && profilePictureDoc.document_url) {
      profilePictureUrl = profilePictureDoc.document_url;
    }
  }
  
  // Fallback to avatar_url if no profile picture found
  if (!profilePictureUrl) {
    profilePictureUrl = profile.avatar_url;
  }

  // Get services
  const services = await db.query(
    `SELECT sc.id, sc.name, sc.slug, sc.icon_url
     FROM provider_services ps
     JOIN service_categories sc ON sc.id = ps.service_id
     WHERE ps.provider_id = ?`,
    [profile.id]
  );

  // Get recent ratings (last 10)
  const ratings = await db.query(
    `SELECT r.rating, r.comment, r.created_at, u.full_name as customer_name
     FROM order_ratings r
     JOIN users u ON u.id = r.rater_id
     WHERE r.rated_id = ? AND r.rater_id != ?
     ORDER BY r.created_at DESC
     LIMIT 10`,
    [providerId, providerId]
  );

  res.json({ 
    profile: {
      user_id: profile.user_id,
      full_name: profile.full_name,
      phone: profile.phone,
      avatar_url: profilePictureUrl, // Use the resolved profile picture URL
      bio: profile.bio,
      is_verified: profile.is_verified,
      membership_status: profile.membership_status,
      accreditation_tier: profile.accreditation_tier,
      average_rating: profile.average_rating,
      total_ratings: profile.total_ratings,
    },
    services,
    ratings 
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
  searchCustomers,
  getPublicProfile,
  updateAvailabilityIfEligible, // Export helper for use in other controllers
};
