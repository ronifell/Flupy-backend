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

// Provider: accept order
router.post('/:id/accept', authorize('provider'), idParam, validate, asyncHandler(orderController.acceptOrder));

// Provider: start order
router.post('/:id/start', authorize('provider'), idParam, validate, asyncHandler(orderController.startOrder));

// Provider: complete order
router.post('/:id/complete', authorize('provider'), idParam, validate, asyncHandler(orderController.completeOrder));

// Both: cancel order
router.post('/:id/cancel', idParam, validate, asyncHandler(orderController.cancelOrder));

// Both: upload media
router.post('/:id/media', uploadPhotos, asyncHandler(orderController.uploadOrderMedia));

module.exports = router;
