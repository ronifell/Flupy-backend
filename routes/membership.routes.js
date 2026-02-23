const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate, authorize } = require('../middleware/auth');
const membershipController = require('../controllers/membership.controller');

// Stripe webhook (raw body, no auth)
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  asyncHandler(membershipController.handleWebhook)
);

// Protected routes (provider only)
router.use(authenticate, authorize('provider'));

router.post('/checkout', asyncHandler(membershipController.createCheckoutSession));
router.get('/status', asyncHandler(membershipController.getMembershipStatus));
router.post('/cancel', asyncHandler(membershipController.cancelMembership));

module.exports = router;
