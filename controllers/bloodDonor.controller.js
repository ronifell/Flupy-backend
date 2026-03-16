const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { t } = require('../i18n');

/**
 * Register user in blood donor network
 */
async function registerBloodDonor(req, res) {
  const userId = req.user.id;
  const { is_registered, blood_type } = req.body;

  // Validate blood type if registering
  if (is_registered) {
    const validBloodTypes = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
    if (!blood_type || !validBloodTypes.includes(blood_type)) {
      throw new AppError('Valid blood type is required (A+, A-, B+, B-, AB+, AB-, O+, O-)', 400);
    }
  }

  // Check if user exists and get country
  const [user] = await db.query('SELECT country FROM users WHERE id = ?', [userId]);
  if (!user) {
    throw new AppError('User not found', 404);
  }

  // Only allow Dominican Republic users
  if (user.country !== 'DR') {
    throw new AppError('Blood donor network is only available for users in Dominican Republic', 403);
  }

  // Insert or update blood donor registration
  await db.query(
    `INSERT INTO blood_donor_network (user_id, is_registered, blood_type)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE 
       is_registered = VALUES(is_registered),
       blood_type = VALUES(blood_type),
       updated_at = NOW()`,
    [userId, is_registered ? 1 : 0, is_registered ? blood_type : null]
  );

  const language = req.language || 'en';
  res.json({
    message: is_registered 
      ? t('messages.bloodDonorRegistered', {}, language)
      : t('messages.bloodDonorUnregistered', {}, language),
  });
}

/**
 * Get blood donor registration status
 */
async function getBloodDonorStatus(req, res) {
  const userId = req.user.id;

  const [donor] = await db.query(
    'SELECT is_registered, blood_type FROM blood_donor_network WHERE user_id = ?',
    [userId]
  );

  res.json({
    is_registered: donor ? donor.is_registered === 1 : false,
    blood_type: donor ? donor.blood_type : null,
  });
}

/**
 * Search for blood donors (for emergency use - could be restricted to admins)
 */
async function searchBloodDonors(req, res) {
  const { blood_type, city } = req.query;

  if (!blood_type) {
    throw new AppError('Blood type is required', 400);
  }

  // Build query
  let query = `
    SELECT 
      bdn.user_id,
      u.full_name,
      u.phone,
      bdn.blood_type,
      ua.city,
      bdn.updated_at
    FROM blood_donor_network bdn
    JOIN users u ON u.id = bdn.user_id
    LEFT JOIN user_addresses ua ON ua.user_id = u.id AND ua.is_default = 1
    WHERE bdn.is_registered = 1
      AND bdn.blood_type = ?
      AND u.country = 'DR'
      AND u.is_active = 1
  `;

  const params = [blood_type];

  if (city) {
    query += ' AND ua.city LIKE ?';
    params.push(`%${city}%`);
  }

  query += ' ORDER BY bdn.updated_at DESC LIMIT 50';

  const donors = await db.query(query, params);

  res.json({ donors });
}

module.exports = {
  registerBloodDonor,
  getBloodDonorStatus,
  searchBloodDonors,
};
