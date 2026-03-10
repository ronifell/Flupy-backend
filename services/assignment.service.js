const db = require('../config/database');
const notificationService = require('./notification.service');

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
    const candidates = await db.query(
      `SELECT
         pp.user_id as provider_id,
         pp.id as provider_profile_id,
         pp.current_lat,
         pp.current_lng,
         urs.average_rating,
         urs.total_ratings,
         ST_Distance_Sphere(
           POINT(pp.current_lng, pp.current_lat),
           POINT(?, ?)
         ) / 1000 AS distance_km
       FROM provider_profiles pp
       JOIN provider_services ps ON ps.provider_id = pp.id
       LEFT JOIN user_rating_summary urs ON urs.user_id = pp.user_id
       WHERE pp.is_available = 1
         AND pp.is_verified = 1
         AND pp.membership_status = 'active'
         AND ps.service_id = ?
         AND pp.current_lat IS NOT NULL
         AND pp.current_lng IS NOT NULL
         AND pp.location_updated_at IS NOT NULL
         AND pp.location_updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
         AND pp.user_id != ?
         AND ST_Distance_Sphere(
               POINT(pp.current_lng, pp.current_lat),
               POINT(?, ?)
             ) / 1000 <= ?
       ORDER BY
         urs.average_rating DESC,
         urs.total_ratings DESC,
         distance_km ASC
       LIMIT 10`,
      [
        order.longitude, order.latitude,
        order.service_id,
        order.customer_id,
        order.longitude, order.latitude,
        radiusKm,
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

      // Send push notifications
      notificationService.sendToUser(bestProvider.provider_id, {
        title: 'New Order Assigned',
        body: 'You have been assigned a new service order.',
        data: { type: 'order_assigned', order_id: orderId },
      });

      notificationService.sendToUser(order.customer_id, {
        title: 'Provider Found',
        body: 'A provider has been assigned to your order.',
        data: { type: 'provider_assigned', order_id: orderId },
      });

      console.log(`✅ Order ${orderId} assigned to provider ${bestProvider.provider_id} (${bestProvider.distance_km.toFixed(1)}km)`);
      return bestProvider;
    }

    console.log(`📍 Order ${orderId}: No candidates at ${radiusKm}km radius, expanding...`);
  }

  // No provider found after all radii
  console.warn(`⚠️  Order ${orderId}: No provider found after expanding to ${SEARCH_RADII_KM[SEARCH_RADII_KM.length - 1]}km`);

  notificationService.sendToUser(order.customer_id, {
    title: 'Searching for Provider',
    body: 'We are still looking for a provider in your area. We will notify you once one is found.',
    data: { type: 'no_provider_found', order_id: orderId },
  });

  return null;
}

module.exports = { assignProvider };
