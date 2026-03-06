const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');
const { validate, appointmentResponseRules, idParam } = require('../utils/validators');
const providerController = require('../controllers/provider.controller');

// All routes require provider auth
router.use(authenticate, authorize('provider'));

// Profile
router.get('/profile', asyncHandler(providerController.getProfile));
router.put('/profile', asyncHandler(providerController.updateProfile));

// Dashboard
router.get('/dashboard', asyncHandler(providerController.getDashboard));

// Availability
router.post('/availability', asyncHandler(providerController.toggleAvailability));

// Location update
router.post('/location', asyncHandler(providerController.updateLocation));

// Document upload
router.post('/documents', uploadSingle, asyncHandler(providerController.uploadDocument));

// Appointment response
router.post(
  '/appointments/:id/respond',
  idParam,
  appointmentResponseRules,
  validate,
  asyncHandler(providerController.respondToAppointment)
);

// Document review (Admin function - for testing, you can call this directly)
// In production, this should be protected with admin authentication
router.post('/documents/:id/review', asyncHandler(providerController.reviewDocument));

module.exports = router;
