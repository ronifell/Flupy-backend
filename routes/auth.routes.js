const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { validate, registerRules, loginRules } = require('../utils/validators');
const authController = require('../controllers/auth.controller');

// Public routes
router.post('/register', registerRules, validate, asyncHandler(authController.register));
router.post('/login', loginRules, validate, asyncHandler(authController.login));

// Protected routes
router.get('/profile', authenticate, asyncHandler(authController.getProfile));
router.put('/profile', authenticate, asyncHandler(authController.updateProfile));
router.post('/push-token', authenticate, asyncHandler(authController.registerPushToken));

module.exports = router;
