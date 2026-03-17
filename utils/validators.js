const { body, param, query } = require('express-validator');
const { validationResult } = require('express-validator');

/**
 * Middleware to check validation result
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      error: 'Validation failed',
      details: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

// ── Auth Validators ──────────────────────────────────────────
const registerRules = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('full_name').trim().notEmpty().withMessage('Full name is required'),
  body('role').isIn(['customer', 'provider']).withMessage('Role must be customer or provider'),
  body('phone').trim().notEmpty().withMessage('Phone number is required').isMobilePhone().withMessage('Invalid phone number'),
];

const loginRules = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

// ── Order Validators ────────────────────────────────────────
const createOrderRules = [
  body('service_id').isInt({ min: 1 }).withMessage('Valid service ID is required'),
  body('description').optional({ nullable: true }).trim(),
  body('order_mode').isIn(['ASAP', 'SCHEDULED']).withMessage('Order mode must be ASAP or SCHEDULED'),
  body('latitude').isDecimal().withMessage('Valid latitude is required'),
  body('longitude').isDecimal().withMessage('Valid longitude is required'),
  body('scheduled_start')
    .if(body('order_mode').equals('SCHEDULED'))
    .isISO8601()
    .withMessage('Scheduled start date is required for scheduled orders'),
  body('scheduled_end')
    .if(body('order_mode').equals('SCHEDULED'))
    .isISO8601()
    .withMessage('Scheduled end date is required for scheduled orders'),
  body('address_id').optional().isInt({ min: 1 }),
  body('address_text').optional().trim(),
];

// ── Rating Validators ───────────────────────────────────────
const ratingRules = [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('comment').optional().trim().isLength({ max: 1000 }),
];

// ── Chat Validators ─────────────────────────────────────────
const messageRules = [
  body('message_text').optional().trim(),
];

// ── Appointment Validators ──────────────────────────────────
const appointmentResponseRules = [
  body('action').isIn(['accept', 'reschedule', 'decline']).withMessage('Action must be accept, reschedule, or decline'),
  body('proposed_start')
    .if(body('action').equals('reschedule'))
    .isISO8601()
    .withMessage('New proposed start is required for reschedule'),
  body('proposed_end')
    .if(body('action').equals('reschedule'))
    .isISO8601()
    .withMessage('New proposed end is required for reschedule'),
  body('response_note').optional().trim(),
];

// ── Address Validators ──────────────────────────────────────
const addressRules = [
  body('address_line').trim().notEmpty().withMessage('Address is required'),
  body('latitude').isDecimal().withMessage('Valid latitude is required'),
  body('longitude').isDecimal().withMessage('Valid longitude is required'),
  body('label').optional().trim(),
  body('city').optional().trim(),
  body('state').optional().trim(),
  body('zip_code').optional().trim(),
  body('is_default').optional().isBoolean(),
];

// ── ID Param ─────────────────────────────────────────────────
const idParam = [
  param('id').isInt({ min: 1 }).withMessage('Valid ID is required'),
];

module.exports = {
  validate,
  registerRules,
  loginRules,
  createOrderRules,
  ratingRules,
  messageRules,
  appointmentResponseRules,
  addressRules,
  idParam,
};
