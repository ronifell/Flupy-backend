const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { validate, ratingRules } = require('../utils/validators');
const ratingController = require('../controllers/rating.controller');

router.use(authenticate);

// Submit rating
router.post('/order/:orderId', ratingRules, validate, asyncHandler(ratingController.submitRating));

// Get ratings for authenticated user
router.get('/me', asyncHandler(ratingController.getUserRatings));

// Get ratings for a specific user
router.get('/user/:userId', asyncHandler(ratingController.getUserRatings));

module.exports = router;
