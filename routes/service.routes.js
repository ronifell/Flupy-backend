const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { validate, idParam } = require('../utils/validators');
const serviceController = require('../controllers/service.controller');

// All service management routes require authentication
router.use(authenticate);

// Get all services (can filter by country query param)
router.get('/', asyncHandler(serviceController.getAllServices));

// Get single service by ID
router.get('/:id', idParam, validate, asyncHandler(serviceController.getServiceById));

// Create new service
router.post('/', asyncHandler(serviceController.createService));

// Update service
router.put('/:id', idParam, validate, asyncHandler(serviceController.updateService));

// Delete/deactivate service
router.delete('/:id', idParam, validate, asyncHandler(serviceController.deleteService));

module.exports = router;
