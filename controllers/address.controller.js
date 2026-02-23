const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

/**
 * Get all addresses for the current user
 */
async function getAddresses(req, res) {
  const userId = req.user.id;

  const addresses = await db.query(
    'SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC',
    [userId]
  );

  res.json({ addresses });
}

/**
 * Add a new address
 */
async function addAddress(req, res) {
  const userId = req.user.id;
  const { label, address_line, city, state, zip_code, latitude, longitude, is_default } = req.body;

  // If this is the default, unset other defaults
  if (is_default) {
    await db.query('UPDATE user_addresses SET is_default = 0 WHERE user_id = ?', [userId]);
  }

  const result = await db.query(
    `INSERT INTO user_addresses (user_id, label, address_line, city, state, zip_code, latitude, longitude, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, label || null, address_line, city || null, state || null, zip_code || null, latitude, longitude, is_default ? 1 : 0]
  );

  res.status(201).json({ message: 'Address added', address_id: result.insertId });
}

/**
 * Update an address
 */
async function updateAddress(req, res) {
  const userId = req.user.id;
  const addressId = req.params.id;
  const { label, address_line, city, state, zip_code, latitude, longitude, is_default } = req.body;

  const [existing] = await db.query(
    'SELECT * FROM user_addresses WHERE id = ? AND user_id = ?',
    [addressId, userId]
  );

  if (!existing) {
    throw new AppError('Address not found', 404);
  }

  if (is_default) {
    await db.query('UPDATE user_addresses SET is_default = 0 WHERE user_id = ?', [userId]);
  }

  await db.query(
    `UPDATE user_addresses
     SET label = ?, address_line = ?, city = ?, state = ?, zip_code = ?, latitude = ?, longitude = ?, is_default = ?
     WHERE id = ?`,
    [
      label || existing.label,
      address_line || existing.address_line,
      city || existing.city,
      state || existing.state,
      zip_code || existing.zip_code,
      latitude || existing.latitude,
      longitude || existing.longitude,
      is_default ? 1 : existing.is_default,
      addressId,
    ]
  );

  res.json({ message: 'Address updated' });
}

/**
 * Delete an address
 */
async function deleteAddress(req, res) {
  const userId = req.user.id;
  const addressId = req.params.id;

  const result = await db.query(
    'DELETE FROM user_addresses WHERE id = ? AND user_id = ?',
    [addressId, userId]
  );

  if (result.affectedRows === 0) {
    throw new AppError('Address not found', 404);
  }

  res.json({ message: 'Address deleted' });
}

module.exports = { getAddresses, addAddress, updateAddress, deleteAddress };
