const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

/**
 * Register a new user (customer or provider)
 */
async function register(req, res) {
  const { email, password, full_name, role, phone } = req.body;

  // Check if user already exists
  const existing = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    throw new AppError('Email is already registered', 409);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await db.query(
    'INSERT INTO users (email, password_hash, full_name, role, phone) VALUES (?, ?, ?, ?, ?)',
    [email, passwordHash, full_name, role, phone || null]
  );

  const userId = result.insertId;

  // If provider, create profile record
  if (role === 'provider') {
    await db.query('INSERT INTO provider_profiles (user_id) VALUES (?)', [userId]);
  }

  // Create rating summary
  await db.query('INSERT INTO user_rating_summary (user_id) VALUES (?)', [userId]);

  const token = generateToken(userId, role);

  res.status(201).json({
    message: 'Registration successful',
    token,
    user: { id: userId, email, full_name, role },
  });
}

/**
 * Login with email and password
 */
async function login(req, res) {
  const { email, password } = req.body;

  const [user] = await db.query(
    'SELECT id, email, password_hash, full_name, role, is_active FROM users WHERE email = ?',
    [email]
  );

  if (!user) {
    throw new AppError('Invalid email or password', 401);
  }

  if (!user.is_active) {
    throw new AppError('Account is deactivated', 403);
  }

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    throw new AppError('Invalid email or password', 401);
  }

  const token = generateToken(user.id, user.role);

  res.json({
    message: 'Login successful',
    token,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
    },
  });
}

/**
 * Get current user's profile
 */
async function getProfile(req, res) {
  const userId = req.user.id;

  const [user] = await db.query(
    `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.avatar_url, u.created_at,
            urs.average_rating, urs.total_ratings
     FROM users u
     LEFT JOIN user_rating_summary urs ON urs.user_id = u.id
     WHERE u.id = ?`,
    [userId]
  );

  let providerProfile = null;
  if (user.role === 'provider') {
    const [profile] = await db.query(
      `SELECT pp.*, GROUP_CONCAT(sc.name) as services
       FROM provider_profiles pp
       LEFT JOIN provider_services ps ON ps.provider_id = pp.id
       LEFT JOIN service_categories sc ON sc.id = ps.service_id
       WHERE pp.user_id = ?
       GROUP BY pp.id`,
      [userId]
    );
    providerProfile = profile || null;
  }

  res.json({ user, provider_profile: providerProfile });
}

/**
 * Update user profile
 */
async function updateProfile(req, res) {
  const userId = req.user.id;
  const { full_name, phone, avatar_url } = req.body;

  const fields = [];
  const values = [];

  if (full_name) { fields.push('full_name = ?'); values.push(full_name); }
  if (phone) { fields.push('phone = ?'); values.push(phone); }
  if (avatar_url) { fields.push('avatar_url = ?'); values.push(avatar_url); }

  if (fields.length === 0) {
    throw new AppError('No fields to update', 400);
  }

  values.push(userId);
  await db.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);

  res.json({ message: 'Profile updated successfully' });
}

/**
 * Register or update push token
 */
async function registerPushToken(req, res) {
  const { token, platform } = req.body;
  const userId = req.user.id;

  await db.query(
    `INSERT INTO push_tokens (user_id, token, platform)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = ?, is_active = 1, updated_at = NOW()`,
    [userId, token, platform || 'android', userId]
  );

  res.json({ message: 'Push token registered' });
}

// ── Helper ──────────────────────────────────────────────────
function generateToken(userId, role) {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

module.exports = { register, login, getProfile, updateProfile, registerPushToken };
