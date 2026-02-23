const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const aiService = require('../services/ai.service');

/**
 * Start a new AI session
 */
async function createSession(req, res) {
  const userId = req.user.id;
  const { context } = req.body;

  const result = await db.query(
    'INSERT INTO ai_sessions (user_id, context) VALUES (?, ?)',
    [userId, context || 'general']
  );

  res.status(201).json({ session_id: result.insertId });
}

/**
 * Send a message to the AI assistant
 */
async function sendMessage(req, res) {
  const userId = req.user.id;
  const sessionId = req.params.sessionId;
  const { message } = req.body;

  if (!message || !message.trim()) {
    throw new AppError('Message is required', 400);
  }

  // Verify session ownership
  const [session] = await db.query(
    'SELECT * FROM ai_sessions WHERE id = ? AND user_id = ?',
    [sessionId, userId]
  );

  if (!session) {
    throw new AppError('Session not found', 404);
  }

  // Save user message
  await db.query(
    'INSERT INTO ai_messages (session_id, role, content) VALUES (?, ?, ?)',
    [sessionId, 'user', message]
  );

  // Get conversation history
  const history = await db.query(
    'SELECT role, content FROM ai_messages WHERE session_id = ? ORDER BY created_at ASC',
    [sessionId]
  );

  // Get AI response (contextual help only)
  const role = req.user.role;
  const aiResponse = await aiService.getContextualHelp(message, history, role, session.context);

  // Save AI response
  await db.query(
    'INSERT INTO ai_messages (session_id, role, content) VALUES (?, ?, ?)',
    [sessionId, 'assistant', aiResponse]
  );

  await db.query('UPDATE ai_sessions SET updated_at = NOW() WHERE id = ?', [sessionId]);

  res.json({ response: aiResponse });
}

/**
 * Get AI session history
 */
async function getSessionMessages(req, res) {
  const userId = req.user.id;
  const sessionId = req.params.sessionId;

  const [session] = await db.query(
    'SELECT * FROM ai_sessions WHERE id = ? AND user_id = ?',
    [sessionId, userId]
  );

  if (!session) {
    throw new AppError('Session not found', 404);
  }

  const messages = await db.query(
    'SELECT id, role, content, created_at FROM ai_messages WHERE session_id = ? ORDER BY created_at ASC',
    [sessionId]
  );

  res.json({ session, messages });
}

/**
 * Get all AI sessions for a user
 */
async function getSessions(req, res) {
  const userId = req.user.id;

  const sessions = await db.query(
    'SELECT * FROM ai_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20',
    [userId]
  );

  res.json({ sessions });
}

module.exports = { createSession, sendMessage, getSessionMessages, getSessions };
