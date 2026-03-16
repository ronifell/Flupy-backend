const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadPhotos } = require('../middleware/upload');
const { validate, createOrderRules, idParam } = require('../utils/validators');
const orderController = require('../controllers/order.controller');

// Service categories (public)
router.get('/categories', asyncHandler(orderController.getServiceCategories));

// Protected routes
router.use(authenticate);

// Customer: create order
router.post(
  '/',
  authorize('customer'),
  uploadPhotos,
  createOrderRules,
  validate,
  asyncHandler(orderController.createOrder)
);

// Get orders (both roles)
router.get('/', asyncHandler(orderController.getOrders));

// Get single order
router.get('/:id', idParam, validate, asyncHandler(orderController.getOrderById));

// Provider: claim unassigned order
router.post('/:id/claim', authorize('provider'), idParam, validate, asyncHandler(orderController.claimOrder));

// Provider: accept order
router.post('/:id/accept', authorize('provider'), idParam, validate, asyncHandler(orderController.acceptOrder));

// Provider: decline order (triggers reassignment)
router.post('/:id/decline', authorize('provider'), idParam, validate, asyncHandler(orderController.declineOrder));

// Customer: search nearby providers
router.get('/:id/providers', authorize('customer'), idParam, validate, asyncHandler(orderController.searchNearbyProviders));

// Customer: approve provider and start service
router.post('/:id/approve', authorize('customer'), idParam, validate, asyncHandler(orderController.approveProvider));

// Provider: start order
router.post('/:id/start', authorize('provider'), idParam, validate, asyncHandler(orderController.startOrder));

// Both: complete order (customer or provider)
router.post('/:id/complete', idParam, validate, asyncHandler(orderController.completeOrder));

// Both: cancel order
router.post('/:id/cancel', idParam, validate, asyncHandler(orderController.cancelOrder));

// Both: upload media
router.post('/:id/media', uploadPhotos, asyncHandler(orderController.uploadOrderMedia));

module.exports = router;
