const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const {
  validate,
  registerRules,
  loginRules,
  forgotPasswordRules,
  resetPasswordRules,
  verifyResetCodeRules,
} = require('../utils/validators');
const authController = require('../controllers/auth.controller');

// Public routes
router.post('/register', registerRules, validate, asyncHandler(authController.register));
router.post('/login', loginRules, validate, asyncHandler(authController.login));
router.post('/forgot-password', forgotPasswordRules, validate, asyncHandler(authController.forgotPassword));
router.post('/verify-reset-code', verifyResetCodeRules, validate, asyncHandler(authController.verifyResetCode));
router.post('/reset-password', resetPasswordRules, validate, asyncHandler(authController.resetPassword));

// Protected routes
router.get('/profile', authenticate, asyncHandler(authController.getProfile));
router.put('/profile', authenticate, asyncHandler(authController.updateProfile));
router.post('/push-token', authenticate, asyncHandler(authController.registerPushToken));

module.exports = router;
