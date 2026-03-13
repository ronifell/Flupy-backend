const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { uploadMultiple } = require('../middleware/upload');
const chatController = require('../controllers/chat.controller');

router.use(authenticate);

// Get conversation for an order
router.get('/order/:orderId', asyncHandler(chatController.getConversation));

// Get or create conversation with a provider (for customers, not tied to an order)
router.get('/provider/:providerId', asyncHandler(chatController.getOrCreateProviderConversation));

// Get messages for a conversation
router.get('/:conversationId/messages', asyncHandler(chatController.getMessages));

// Send message (REST fallback)
router.post('/:conversationId/messages', uploadMultiple, asyncHandler(chatController.sendMessage));

module.exports = router;
