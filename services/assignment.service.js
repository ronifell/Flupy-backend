const db = require('../config/database');
const notificationService = require('./notification.service');
const { t } = require('../i18n');

const SEARCH_RADII_KM = [3, 5, 8, 12, 20];
const EARTH_RADIUS_M = 6371000;

/**
 * Automatic Provider Assignment Engine
 *
 * 1. Filters eligible providers (available, verified, active membership, offers service, recent location)
 * 2. Calculates distance using ST_Distance_Sphere
 * 3. Sorts by rating (desc), rating_count (desc), distance (asc)
 * 4. Expands search radius if no candidates found
 * 5. Records audit trail in order_assignment_attempts & order_assignment_candidates
 * 6. Assigns best provider and creates conversation
 */
async function assignProvider(orderId) {
  // Fetch order details
  const [order] = await db.query(
    'SELECT * FROM service_orders WHERE id = ? AND status IN (?, ?)',
    [orderId, 'CREATED', 'SEARCHING']
  );

  if (!order) {
    console.warn(`Assignment: Order ${orderId} not found or already assigned`);
    return null;
  }

  console.log(`[Assignment] Starting assignment for order ${orderId}`);
  console.log(`[Assignment] Order details:`, {
    service_id: order.service_id,
    latitude: order.latitude,
    longitude: order.longitude,
    customer_id: order.customer_id,
  });

  // Diagnostic: Check available providers (without distance/radius filter)
  const allProviders = await db.query(
    `SELECT 
      pp.id,
      pp.user_id,
      pp.is_available,
      pp.is_verified,
      pp.membership_status,
      pp.current_lat,
      pp.current_lng,
      pp.location_updated_at,
      TIMESTAMPDIFF(MINUTE, pp.location_updated_at, NOW()) as minutes_since_location_update,
      GROUP_CONCAT(ps.service_id) as offered_services
    FROM provider_profiles pp
    LEFT JOIN provider_services ps ON ps.provider_id = pp.id
    WHERE pp.user_id != ?
    GROUP BY pp.id, pp.user_id`,
    [order.customer_id]
  );
  
  console.log(`[Assignment] Total providers in system: ${allProviders.length}`);
  console.log(`[Assignment] All providers status:`, allProviders.map(p => {
    const offersService = p.offered_services ? p.offered_services.split(',').includes(String(order.service_id)) : false;
    const hasLocation = !!(p.current_lat && p.current_lng);
    const locationRecent = p.location_updated_at ? (p.minutes_since_location_update <= 30) : false;
    const eligible = p.is_available === 1 && p.is_verified === 1 && p.membership_status === 'active' && offersService && hasLocation && locationRecent;
    
    return {
      provider_id: p.id,
      user_id: p.user_id,
      is_available: p.is_available,
      is_verified: p.is_verified,
      membership_status: p.membership_status,
      has_location: hasLocation,
      location_age_minutes: p.minutes_since_location_update,
      location_recent: locationRecent,
      offers_service: offersService,
      offered_services: p.offered_services,
      ELIGIBLE: eligible,
      rejection_reasons: [
        p.is_available !== 1 && 'not_available',
        p.is_verified !== 1 && 'not_verified',
        p.membership_status !== 'active' && 'no_active_membership',
        !offersService && 'doesnt_offer_service',
        !hasLocation && 'no_location',
        !locationRecent && 'location_too_old'
      ].filter(Boolean)
    };
  }));

  let attemptNumber = 0;

  for (const radiusKm of SEARCH_RADII_KM) {
    attemptNumber++;

    // Find eligible providers within radius
    // Consider both current GPS location and stored addresses
    // Use the closest location (GPS if recent, otherwise closest address)
    const candidates = await db.query(
      `SELECT
         pp.user_id as provider_id,
         pp.id as provider_profile_id,
         pp.current_lat,
         pp.current_lng,
         pp.location_updated_at,
         urs.average_rating,
         urs.total_ratings,
         -- Calculate distance from current GPS if available and recent
         CASE 
           WHEN pp.current_lat IS NOT NULL 
             AND pp.current_lng IS NOT NULL 
             AND pp.location_updated_at IS NOT NULL
             AND pp.location_updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
           THEN ST_Distance_Sphere(
             POINT(pp.current_lng, pp.current_lat),
             POINT(?, ?)
           ) / 1000
           -- Otherwise use closest address
           ELSE (
             SELECT MIN(ST_Distance_Sphere(
               POINT(ua.longitude, ua.latitude),
               POINT(?, ?)
             ) / 1000)
             FROM user_addresses ua
             WHERE ua.user_id = pp.user_id
           )
         END AS distance_km,
         -- Determine which location is being used
         CASE 
           WHEN pp.current_lat IS NOT NULL 
             AND pp.current_lng IS NOT NULL 
             AND pp.location_updated_at IS NOT NULL
             AND pp.location_updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
           THEN 'gps'
           ELSE 'address'
         END AS location_type
       FROM provider_profiles pp
       JOIN provider_services ps ON ps.provider_id = pp.id
       LEFT JOIN user_rating_summary urs ON urs.user_id = pp.user_id
       WHERE pp.is_available = 1
         AND pp.is_verified = 1
         AND pp.membership_status = 'active'
         AND ps.service_id = ?
         AND pp.user_id != ?
         -- Must have either recent GPS location OR at least one stored address
         AND (
           (pp.current_lat IS NOT NULL 
            AND pp.current_lng IS NOT NULL 
            AND pp.location_updated_at IS NOT NULL
            AND pp.location_updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE))
           OR EXISTS (
             SELECT 1 FROM user_addresses ua WHERE ua.user_id = pp.user_id
           )
         )
         -- Distance check: either GPS or closest address must be within radius
         AND (
           -- GPS location within radius
           (pp.current_lat IS NOT NULL 
            AND pp.current_lng IS NOT NULL 
            AND pp.location_updated_at IS NOT NULL
            AND pp.location_updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
            AND ST_Distance_Sphere(
              POINT(pp.current_lng, pp.current_lat),
              POINT(?, ?)
            ) / 1000 <= ?)
           -- OR closest address within radius
           OR (
             SELECT MIN(ST_Distance_Sphere(
               POINT(ua.longitude, ua.latitude),
               POINT(?, ?)
             ) / 1000)
             FROM user_addresses ua
             WHERE ua.user_id = pp.user_id
           ) <= ?
         )
       ORDER BY
         urs.average_rating DESC,
         urs.total_ratings DESC,
         distance_km ASC
       LIMIT 10`,
      [
        order.longitude, order.latitude,  // For GPS distance calculation
        order.longitude, order.latitude,  // For address distance calculation
        order.service_id,
        order.customer_id,
        order.longitude, order.latitude,  // For GPS radius check
        radiusKm,                          // GPS radius
        order.longitude, order.latitude,  // For address radius check
        radiusKm,                          // Address radius
      ]
    );
    
    console.log(`[Assignment] Radius ${radiusKm}km: Found ${candidates.length} eligible candidates`);
    if (candidates.length > 0) {
      console.log(`[Assignment] Candidates:`, candidates.map(c => ({
        provider_id: c.provider_id,
        distance_km: c.distance_km?.toFixed(2),
        rating: c.average_rating,
        rating_count: c.total_ratings
      })));
    }

    // Record attempt
    const attemptResult = await db.query(
      `INSERT INTO order_assignment_attempts
        (order_id, attempt_number, search_radius_km, candidates_found, result)
       VALUES (?, ?, ?, ?, ?)`,
      [
        orderId,
        attemptNumber,
        radiusKm,
        candidates.length,
        candidates.length > 0 ? 'ASSIGNED' : 'NO_CANDIDATES',
      ]
    );
    const attemptId = attemptResult.insertId;

    // Record candidates
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      await db.query(
        `INSERT INTO order_assignment_candidates
          (attempt_id, provider_id, distance_km, rating, rating_count, rank_position, was_selected)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [attemptId, c.provider_id, c.distance_km, c.average_rating || null, c.total_ratings || 0, i + 1, i === 0 ? 1 : 0]
      );
    }

    if (candidates.length > 0) {
      const bestProvider = candidates[0];

      // Assign the provider
      await db.query(
        `UPDATE service_orders
         SET provider_id = ?, status = 'ASSIGNED', assigned_at = NOW()
         WHERE id = ?`,
        [bestProvider.provider_id, orderId]
      );

      // Update attempt result
      await db.query(
        'UPDATE order_assignment_attempts SET assigned_provider_id = ?, result = ? WHERE id = ?',
        [bestProvider.provider_id, 'ASSIGNED', attemptId]
      );

      // Create conversation
      await db.query(
        `INSERT INTO order_conversations (order_id, customer_id, provider_id)
         VALUES (?, ?, ?)`,
        [orderId, order.customer_id, bestProvider.provider_id]
      );

      // Get user language preferences (default to 'en' for now)
      // TODO: Get actual language from user preferences
      const providerLang = 'en';
      const customerLang = 'en';

      // Send push notifications
      notificationService.sendToUser(bestProvider.provider_id, {
        title: t('notifications.newOrderAssigned.title', {}, providerLang),
        body: t('notifications.newOrderAssigned.body', {}, providerLang),
        data: { type: 'order_assigned', order_id: orderId },
      });

      notificationService.sendToUser(order.customer_id, {
        title: t('notifications.providerFound.title', {}, customerLang),
        body: t('notifications.providerFound.body', {}, customerLang),
        data: { type: 'provider_assigned', order_id: orderId },
      });

      console.log(`✅ Order ${orderId} assigned to provider ${bestProvider.provider_id} (${bestProvider.distance_km.toFixed(1)}km)`);
      return bestProvider;
    }

    console.log(`📍 Order ${orderId}: No candidates at ${radiusKm}km radius, expanding...`);
  }

  // No provider found after all radii
  console.warn(`⚠️  Order ${orderId}: No provider found after expanding to ${SEARCH_RADII_KM[SEARCH_RADII_KM.length - 1]}km`);

  // Get customer language (default to 'en' for now)
  // TODO: Get actual language from user preferences
  const customerLang = 'en';

  notificationService.sendToUser(order.customer_id, {
    title: t('notifications.searchingProvider.title', {}, customerLang),
    body: t('notifications.searchingProvider.body', {}, customerLang),
    data: { type: 'no_provider_found', order_id: orderId },
  });

  return null;
}

/**
 * Search for nearby providers without assigning them
 * Returns a list of eligible providers sorted by rating and distance
 */
async function searchNearbyProviders(orderId, maxRadiusKm = 20) {
  // Fetch order details
  const [order] = await db.query(
    'SELECT * FROM service_orders WHERE id = ? AND status = ?',
    [orderId, 'SEARCHING']
  );

  if (!order) {
    throw new Error('Order not found or not in SEARCHING status');
  }

  console.log(`[SearchProviders] Searching for order ${orderId}, service_id: ${order.service_id}, radius: ${maxRadiusKm}km`);
  console.log(`[SearchProviders] Order location: lat=${order.latitude}, lng=${order.longitude}`);
  console.log(`[SearchProviders] Customer ID: ${order.customer_id}`);

  // Diagnostic: Check all providers with addresses near the order location
  const diagnosticProviders = await db.query(
    `SELECT 
      pp.user_id,
      pp.id as provider_profile_id,
      u.full_name,
      pp.is_available,
      pp.is_verified,
      pp.membership_status,
      pp.current_lat,
      pp.current_lng,
      pp.location_updated_at,
      TIMESTAMPDIFF(MINUTE, pp.location_updated_at, NOW()) as minutes_since_location_update,
      GROUP_CONCAT(DISTINCT ps.service_id) as offered_services,
      COUNT(DISTINCT ua.id) as address_count,
      MIN(ST_Distance_Sphere(
        POINT(ua.longitude, ua.latitude),
        POINT(?, ?)
      ) / 1000) as min_address_distance_km
    FROM provider_profiles pp
    JOIN users u ON u.id = pp.user_id
    LEFT JOIN provider_services ps ON ps.provider_id = pp.id
    LEFT JOIN user_addresses ua ON ua.user_id = pp.user_id
    WHERE pp.user_id != ?
      AND (
        (pp.current_lat IS NOT NULL AND pp.current_lng IS NOT NULL)
        OR EXISTS (SELECT 1 FROM user_addresses ua2 WHERE ua2.user_id = pp.user_id)
      )
    GROUP BY pp.user_id, pp.id, u.full_name, pp.is_available, pp.is_verified, 
             pp.membership_status, pp.current_lat, pp.current_lng, pp.location_updated_at
    HAVING min_address_distance_km IS NOT NULL OR 
           (pp.current_lat IS NOT NULL AND pp.current_lng IS NOT NULL)`,
    [order.longitude, order.latitude, order.customer_id]
  );

  console.log(`[SearchProviders] Diagnostic: Found ${diagnosticProviders.length} providers with addresses near order location`);
  diagnosticProviders.forEach(p => {
    const hasRecentGPS = p.current_lat && p.current_lng && p.location_updated_at && p.minutes_since_location_update <= 30;
    const offersService = p.offered_services ? p.offered_services.split(',').includes(String(order.service_id)) : false;
    const eligible = p.is_available === 1 && p.is_verified === 1 && p.membership_status === 'active' && offersService;
    
    console.log(`[SearchProviders] Provider ${p.user_id} (${p.full_name}):`, {
      is_available: p.is_available,
      is_verified: p.is_verified,
      membership_status: p.membership_status,
      has_recent_gps: hasRecentGPS,
      offers_service: offersService,
      offered_services: p.offered_services,
      address_count: p.address_count,
      min_distance_km: p.min_address_distance_km,
      ELIGIBLE: eligible,
      rejection_reasons: [
        p.is_available !== 1 && 'not_available',
        p.is_verified !== 1 && 'not_verified',
        p.membership_status !== 'active' && 'no_active_membership',
        !offersService && 'doesnt_offer_service',
      ].filter(Boolean)
    });
  });

  // Use the same search logic as assignProvider but return all candidates
  // Fixed: Handle NULL values properly and ensure all eligible providers are found
  const candidates = await db.query(
    `SELECT DISTINCT
       pp.user_id as provider_id,
       pp.id as provider_profile_id,
       u.full_name as provider_name,
       u.phone as provider_phone,
       u.avatar_url,
       pp.profile_picture_url,
       pp.accreditation_tier,
       pp.current_lat,
       pp.current_lng,
       pp.location_updated_at,
       urs.average_rating,
       urs.total_ratings,
       -- Calculate distance from current GPS if available and recent, otherwise use closest address
       COALESCE(
         CASE 
           WHEN pp.current_lat IS NOT NULL 
             AND pp.current_lng IS NOT NULL 
             AND pp.location_updated_at IS NOT NULL
             AND pp.location_updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
           THEN ST_Distance_Sphere(
             POINT(pp.current_lng, pp.current_lat),
             POINT(?, ?)
           ) / 1000
           ELSE NULL
         END,
         (
           SELECT MIN(ST_Distance_Sphere(
             POINT(ua.longitude, ua.latitude),
             POINT(?, ?)
           ) / 1000)
           FROM user_addresses ua
           WHERE ua.user_id = pp.user_id
         )
       ) AS distance_km,
       -- Determine which location is being used
       CASE 
         WHEN pp.current_lat IS NOT NULL 
           AND pp.current_lng IS NOT NULL 
           AND pp.location_updated_at IS NOT NULL
           AND pp.location_updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
         THEN 'gps'
         ELSE 'address'
       END AS location_type
     FROM provider_profiles pp
     JOIN provider_services ps ON ps.provider_id = pp.id
     JOIN users u ON u.id = pp.user_id
     LEFT JOIN user_rating_summary urs ON urs.user_id = pp.user_id
     WHERE pp.is_available = 1
       AND pp.is_verified = 1
       AND pp.membership_status = 'active'
       AND ps.service_id = ?
       AND pp.user_id != ?
       -- Must have either recent GPS location OR at least one stored address
       AND (
         (pp.current_lat IS NOT NULL 
          AND pp.current_lng IS NOT NULL 
          AND pp.location_updated_at IS NOT NULL
          AND pp.location_updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE))
         OR EXISTS (
           SELECT 1 FROM user_addresses ua WHERE ua.user_id = pp.user_id
         )
       )
       -- Distance check: either GPS or closest address must be within radius
       -- Fixed: Check both GPS and address distances properly
       AND (
         -- Option 1: GPS location is recent AND within radius
         (pp.current_lat IS NOT NULL 
          AND pp.current_lng IS NOT NULL 
          AND pp.location_updated_at IS NOT NULL
          AND pp.location_updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
          AND ST_Distance_Sphere(
            POINT(pp.current_lng, pp.current_lat),
            POINT(?, ?)
          ) / 1000 <= ?)
         -- Option 2: Provider has addresses AND closest address is within radius
         -- (This applies even if GPS exists but is outside radius or not recent)
         OR EXISTS (
           SELECT 1
           FROM user_addresses ua
           WHERE ua.user_id = pp.user_id
             AND ST_Distance_Sphere(
               POINT(ua.longitude, ua.latitude),
               POINT(?, ?)
             ) / 1000 <= ?
         )
       )
     ORDER BY
       urs.average_rating DESC,
       urs.total_ratings DESC,
       distance_km ASC
     LIMIT 20`,
    [
      order.longitude, order.latitude,  // For GPS distance calculation
      order.longitude, order.latitude,  // For address distance calculation
      order.service_id,
      order.customer_id,
      order.longitude, order.latitude,  // For GPS radius check
      maxRadiusKm,                      // GPS radius
      order.longitude, order.latitude,  // For address radius check
      maxRadiusKm,                      // Address radius
    ]
  );

  console.log(`[SearchProviders] Query returned ${candidates.length} providers`);
  if (candidates.length > 0) {
    console.log(`[SearchProviders] Provider IDs found: ${candidates.map(c => c.provider_id).join(', ')}`);
    candidates.forEach(c => {
      console.log(`[SearchProviders] - Provider ${c.provider_id} (${c.provider_name}): distance=${c.distance_km}km, location_type=${c.location_type}`);
    });
  } else {
    console.log(`[SearchProviders] WARNING: No providers found! Check diagnostic output above.`);
  }

  // Additional diagnostic: Check what providers would be found if we relaxed the filters
  const allProvidersWithService = await db.query(
    `SELECT DISTINCT
      pp.user_id,
      pp.id as provider_profile_id,
      u.full_name,
      pp.is_available,
      pp.is_verified,
      pp.membership_status,
      GROUP_CONCAT(DISTINCT ps.service_id) as offered_services
    FROM provider_profiles pp
    JOIN provider_services ps ON ps.provider_id = pp.id
    JOIN users u ON u.id = pp.user_id
    WHERE ps.service_id = ?
      AND pp.user_id != ?
    GROUP BY pp.user_id, pp.id, u.full_name, pp.is_available, pp.is_verified, pp.membership_status`,
    [order.service_id, order.customer_id]
  );

  console.log(`[SearchProviders] Total providers offering service ${order.service_id}: ${allProvidersWithService.length}`);
  allProvidersWithService.forEach(p => {
    const meetsCriteria = p.is_available === 1 && p.is_verified === 1 && p.membership_status === 'active';
    console.log(`[SearchProviders] - Provider ${p.user_id} (${p.full_name}): available=${p.is_available}, verified=${p.is_verified}, membership=${p.membership_status}, MEETS_CRITERIA=${meetsCriteria}`);
  });

  // Resolve profile picture URLs for each candidate
  const candidatesWithPictures = await Promise.all(
    candidates.map(async (candidate) => {
      let profilePictureUrl = candidate.profile_picture_url || null;
      
      // If not found in profile_picture_url, check documents
      if (!profilePictureUrl) {
        const [profilePictureDoc] = await db.query(
          `SELECT document_url 
           FROM provider_documents 
           WHERE provider_id = ? AND is_profile_picture = 1 AND status = 'approved' 
           ORDER BY created_at DESC 
           LIMIT 1`,
          [candidate.provider_profile_id]
        );
        if (profilePictureDoc && profilePictureDoc.document_url) {
          profilePictureUrl = profilePictureDoc.document_url;
        }
      }
      
      // Fallback to avatar_url if no profile picture found
      if (!profilePictureUrl) {
        profilePictureUrl = candidate.avatar_url;
      }

      return {
        ...candidate,
        avatar_url: profilePictureUrl, // Use resolved profile picture URL
      };
    })
  );

  return candidatesWithPictures;
}

module.exports = { assignProvider, searchNearbyProviders };
