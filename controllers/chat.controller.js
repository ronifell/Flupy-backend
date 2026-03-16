const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { buildFileUrl, parsePagination } = require('../utils/helpers');

/**
 * Get conversation for an order
 */
async function getConversation(req, res) {
  const orderId = req.params.orderId;
  const userId = req.user.id;

  const [conversation] = await db.query(
    `SELECT oc.*, u_cust.full_name as customer_name, u_prov.full_name as provider_name
     FROM order_conversations oc
     JOIN users u_cust ON u_cust.id = oc.customer_id
     JOIN users u_prov ON u_prov.id = oc.provider_id
     WHERE oc.order_id = ? AND (oc.customer_id = ? OR oc.provider_id = ?)`,
    [orderId, userId, userId]
  );

  if (!conversation) {
    throw new AppError('Conversation not found or access denied', 404);
  }

  res.json({ conversation });
}

/**
 * Get messages for a conversation (paginated)
 */
async function getMessages(req, res) {
  const conversationId = req.params.conversationId;
  const userId = req.user.id;
  const { limit, offset } = parsePagination(req.query);

  // Verify access
  const [conversation] = await db.query(
    'SELECT * FROM order_conversations WHERE id = ? AND (customer_id = ? OR provider_id = ?)',
    [conversationId, userId, userId]
  );

  if (!conversation) {
    throw new AppError('Conversation not found or access denied', 404);
  }

  const messages = await db.query(
    `SELECT cm.*, u.full_name as sender_name, u.avatar_url as sender_avatar
     FROM conversation_messages cm
     JOIN users u ON u.id = cm.sender_id
     WHERE cm.conversation_id = ?
     ORDER BY cm.created_at DESC
     LIMIT ? OFFSET ?`,
    [conversationId, limit, offset]
  );

  // Ensure messages is an array
  const messagesArray = Array.isArray(messages) ? messages : [];

  // Get attachments for these messages
  if (messagesArray.length > 0) {
    const messageIds = messagesArray.map((m) => m.id);
    const placeholders = messageIds.map(() => '?').join(',');
    const attachmentsResult = await db.query(
      `SELECT * FROM message_attachments WHERE message_id IN (${placeholders})`,
      messageIds
    );

    // Ensure attachments is an array
    const attachmentsArray = Array.isArray(attachmentsResult) ? attachmentsResult : [];

    // Map attachments to messages
    const attachmentMap = {};
    for (const att of attachmentsArray) {
      if (!attachmentMap[att.message_id]) attachmentMap[att.message_id] = [];
      attachmentMap[att.message_id].push(att);
    }

    // Add attachments to messages
    for (const msg of messagesArray) {
      msg.attachments = attachmentMap[msg.id] || [];
    }
  }

  // Mark messages as read
  await db.query(
    `UPDATE conversation_messages
     SET is_read = 1
     WHERE conversation_id = ? AND sender_id != ? AND is_read = 0`,
    [conversationId, userId]
  );

  res.json({ messages: messagesArray.reverse() });
}

/**
 * Send a message (REST fallback – primary is Socket.IO)
 */
async function sendMessage(req, res) {
  const conversationId = req.params.conversationId;
  const userId = req.user.id;
  const { message_text } = req.body;

  // Verify access
  const [conversation] = await db.query(
    'SELECT * FROM order_conversations WHERE id = ? AND (customer_id = ? OR provider_id = ?) AND is_active = 1',
    [conversationId, userId, userId]
  );

  if (!conversation) {
    throw new AppError('Conversation not found or inactive', 404);
  }

  const result = await db.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, message_text)
     VALUES (?, ?, ?)`,
    [conversationId, userId, message_text || '']
  );

  const messageId = result.insertId;

  // Handle file attachments
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      const url = buildFileUrl(req, file.filename);
      await db.query(
        `INSERT INTO message_attachments (message_id, file_url, file_type, file_name, file_size)
         VALUES (?, ?, ?, ?, ?)`,
        [messageId, url, file.mimetype, file.originalname, file.size]
      );
    }
  }

  // Notify the other party
  const notificationService = require('../services/notification.service');
  const recipientId = userId === conversation.customer_id
    ? conversation.provider_id
    : conversation.customer_id;

  const language = req.language || 'en';
  const { t } = require('../i18n');
  notificationService.sendToUser(recipientId, {
    title: t('notifications.newMessage.title', {}, language),
    body: message_text || t('notifications.newMessage.body', {}, language),
    data: { type: 'new_message', conversation_id: conversationId, order_id: conversation.order_id },
  });

  res.status(201).json({ message: t('messages.messageSent', {}, language), message_id: messageId });
}

/**
 * Get or create a conversation between customer and provider (not tied to an order)
 */
async function getOrCreateProviderConversation(req, res) {
  const providerId = req.params.providerId;
  const customerId = req.user.id;

  if (req.user.role !== 'customer') {
    throw new AppError('Only customers can initiate conversations with providers', 403);
  }

  // Check if provider exists
  const [provider] = await db.query(
    'SELECT id FROM provider_profiles WHERE user_id = ?',
    [providerId]
  );

  if (!provider) {
    throw new AppError('Provider not found', 404);
  }

  // Check if there's an existing conversation without an order (direct chat)
  // Prefer conversations without order_id, but also check for any active conversation
  let [conversation] = await db.query(
    `SELECT oc.*, u_cust.full_name as customer_name, u_prov.full_name as provider_name
     FROM order_conversations oc
     JOIN users u_cust ON u_cust.id = oc.customer_id
     JOIN users u_prov ON u_prov.id = oc.provider_id
     WHERE oc.customer_id = ? AND oc.provider_id = ? AND oc.is_active = 1
       AND oc.order_id IS NULL
     ORDER BY oc.created_at DESC
     LIMIT 1`,
    [customerId, providerId]
  );

  // If no conversation exists, create one (with NULL order_id)
  // Note: Schema needs to allow NULL order_id. If migration hasn't been run, this will fail.
  if (!conversation) {
    try {
      const result = await db.query(
        `INSERT INTO order_conversations (order_id, customer_id, provider_id, is_active)
         VALUES (NULL, ?, ?, 1)`,
        [customerId, providerId]
      );

      // Fetch the created conversation
      [conversation] = await db.query(
        `SELECT oc.*, u_cust.full_name as customer_name, u_prov.full_name as provider_name
         FROM order_conversations oc
         JOIN users u_cust ON u_cust.id = oc.customer_id
         JOIN users u_prov ON u_prov.id = oc.provider_id
         WHERE oc.id = ?`,
        [result.insertId]
      );
    } catch (error) {
      // If order_id cannot be NULL, provide helpful error message
      if (error.code === 'ER_BAD_NULL_ERROR' || error.message.includes('NULL') || error.code === 'ER_NO_DEFAULT_FOR_FIELD') {
        console.error('Schema migration needed: order_id in order_conversations must allow NULL');
        throw new AppError('Direct messaging feature requires database update. Please run migration to allow NULL order_id.', 500);
      }
      throw error;
    }
  }

  res.json({ conversation });
}

module.exports = { getConversation, getMessages, sendMessage, getOrCreateProviderConversation };
