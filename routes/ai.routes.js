const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const aiController = require('../controllers/ai.controller');

router.use(authenticate);

// Sessions
router.get('/sessions', asyncHandler(aiController.getSessions));
router.post('/sessions', asyncHandler(aiController.createSession));

// Messages
router.get('/sessions/:sessionId/messages', asyncHandler(aiController.getSessionMessages));
router.post('/sessions/:sessionId/messages', asyncHandler(aiController.sendMessage));

module.exports = router;
