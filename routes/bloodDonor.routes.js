const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const bloodDonorController = require('../controllers/bloodDonor.controller');

// All routes require authentication
router.use(authenticate);

// Register/unregister in blood donor network
router.post('/register', asyncHandler(bloodDonorController.registerBloodDonor));

// Get blood donor status
router.get('/status', asyncHandler(bloodDonorController.getBloodDonorStatus));

// Search blood donors (public endpoint - could be restricted to admins in production)
router.get('/search', asyncHandler(bloodDonorController.searchBloodDonors));

module.exports = router;
