const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate, authorize } = require('../middleware/auth');
const membershipController = require('../controllers/membership.controller');

// Stripe webhook (raw body applied at server.js level, no auth needed)
router.post('/webhook', asyncHandler(membershipController.handleWebhook));

// Protected routes (provider only)
router.use(authenticate, authorize('provider'));

router.post('/checkout', asyncHandler(membershipController.createCheckoutSession));
router.get('/status', asyncHandler(membershipController.getMembershipStatus));
router.post('/cancel', asyncHandler(membershipController.cancelMembership));

// Check for expiring/expired memberships (can also be called via cron)
router.post('/check-expiry', asyncHandler(membershipController.checkExpiringMemberships));

module.exports = router;
