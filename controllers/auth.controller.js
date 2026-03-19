const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { t } = require('../i18n');

/**
 * Register a new user (customer or provider)
 */
async function register(req, res) {
  const { email, password, full_name, role, phone, country, provider_type, rnc, personal_id } = req.body;

  // Validate required fields
  if (!country) {
    throw new AppError('Country is required', 400);
  }

  // Check if user already exists
  const existing = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    throw new AppError('Email is already registered', 409);
  }

  // Validate provider-specific fields
  if (role === 'provider') {
    if (!provider_type || !['Person', 'Company'].includes(provider_type)) {
      throw new AppError('Provider type must be either "Person" or "Company"', 400);
    }
    if (provider_type === 'Company' && !rnc) {
      throw new AppError('RNC (Company ID) is required for Company providers', 400);
    }
    if (provider_type === 'Person' && !personal_id) {
      throw new AppError('Personal ID is required for Person providers', 400);
    }
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await db.query(
    'INSERT INTO users (email, password_hash, full_name, role, phone, country) VALUES (?, ?, ?, ?, ?, ?)',
    [email, passwordHash, full_name, role, phone, country]
  );

  const userId = result.insertId;

  // If provider, create profile record with provider type and ID fields
  if (role === 'provider') {
    await db.query(
      'INSERT INTO provider_profiles (user_id, provider_type, rnc, personal_id) VALUES (?, ?, ?, ?)',
      [userId, provider_type, rnc || null, personal_id || null]
    );
  }

  // Create rating summary
  await db.query('INSERT INTO user_rating_summary (user_id) VALUES (?)', [userId]);

  // Handle blood donor network registration if provided (only for DR users)
  const { blood_donor_registered, blood_type } = req.body;
  if (country === 'DR' && blood_donor_registered && blood_type) {
    const validBloodTypes = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
    if (validBloodTypes.includes(blood_type)) {
      await db.query(
        `INSERT INTO blood_donor_network (user_id, is_registered, blood_type)
         VALUES (?, 1, ?)`,
        [userId, blood_type]
      );
    }
  }

  const token = generateToken(userId, role);
  const language = req.language || 'en';

  res.status(201).json({
    message: t('messages.registrationSuccessful', {}, language),
    token,
    user: { id: userId, email, full_name, role, country },
  });
}

/**
 * Login with email and password
 */
async function login(req, res) {
  const { email, password } = req.body;

  const [user] = await db.query(
    'SELECT id, email, password_hash, full_name, role, country, is_active FROM users WHERE email = ?',
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
  const language = req.language || 'en';

  res.json({
    message: t('messages.loginSuccessful', {}, language),
    token,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      country: user.country,
    },
  });
}

/**
 * Forgot password request
 * NOTE: We intentionally return the same success response whether or not
 * the email exists to prevent account enumeration.
 */
async function forgotPassword(req, res) {
  const { email } = req.body;
  const language = req.language || 'en';

  try {
    const [user] = await db.query('SELECT id, email FROM users WHERE email = ?', [email]);

    // TODO: integrate real email delivery + reset token flow.
    // For now, keep endpoint behavior stable for the mobile app and avoid leaking
    // whether an account exists.
    if (user) {
      console.log('[Auth] Forgot password requested for user:', user.email);
    } else {
      console.log('[Auth] Forgot password requested for unknown email');
    }
  } catch (error) {
    // Swallow internal errors for this endpoint to avoid email enumeration patterns.
    console.warn('[Auth] Forgot password flow warning:', error.message);
  }

  res.json({
    message: t('messages.resetLinkSent', {}, language),
  });
}

/**
 * Get current user's profile
 */
async function getProfile(req, res) {
  const userId = req.user.id;

  const [user] = await db.query(
    `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.avatar_url, u.country, u.created_at,
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
  const language = req.language || 'en';

  res.json({ message: t('messages.profileUpdated', {}, language) });
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
  const language = req.language || 'en';

  res.json({ message: t('messages.pushTokenRegistered', {}, language) });
}

// ── Helper ──────────────────────────────────────────────────
function generateToken(userId, role) {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

module.exports = { register, login, forgotPassword, getProfile, updateProfile, registerPushToken };
