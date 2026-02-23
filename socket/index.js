const jwt = require('jsonwebtoken');
const db = require('../config/database');

/**
 * Socket.IO setup for real-time chat
 */
function setupSocketIO(io) {
  // ── Authentication middleware ─────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const [user] = await db.query(
        'SELECT id, email, full_name, role FROM users WHERE id = ? AND is_active = 1',
        [decoded.userId]
      );

      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = user;
      next();
    } catch (error) {
      next(new Error('Invalid token'));
    }
  });

  // ── Connection handler ────────────────────────────────────
  io.on('connection', (socket) => {
    const userId = socket.user.id;
    console.log(`🔌 User connected: ${socket.user.full_name} (${userId})`);

    // Join personal room for notifications
    socket.join(`user:${userId}`);

    // ── Join a conversation room ────────────────────────────
    socket.on('join_conversation', async (conversationId) => {
      try {
        const [conversation] = await db.query(
          'SELECT * FROM order_conversations WHERE id = ? AND (customer_id = ? OR provider_id = ?)',
          [conversationId, userId, userId]
        );

        if (!conversation) {
          socket.emit('error', { message: 'Conversation not found' });
          return;
        }

        socket.join(`conversation:${conversationId}`);
        socket.emit('joined_conversation', { conversation_id: conversationId });

        // Mark messages as read
        await db.query(
          `UPDATE conversation_messages
           SET is_read = 1
           WHERE conversation_id = ? AND sender_id != ? AND is_read = 0`,
          [conversationId, userId]
        );
      } catch (error) {
        socket.emit('error', { message: 'Failed to join conversation' });
      }
    });

    // ── Leave a conversation room ───────────────────────────
    socket.on('leave_conversation', (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
    });

    // ── Send a chat message ─────────────────────────────────
    socket.on('send_message', async (data) => {
      try {
        const { conversation_id, message_text, attachments } = data;

        // Verify access
        const [conversation] = await db.query(
          'SELECT * FROM order_conversations WHERE id = ? AND (customer_id = ? OR provider_id = ?) AND is_active = 1',
          [conversation_id, userId, userId]
        );

        if (!conversation) {
          socket.emit('error', { message: 'Conversation not found or inactive' });
          return;
        }

        // Save message
        const result = await db.query(
          `INSERT INTO conversation_messages (conversation_id, sender_id, message_text)
           VALUES (?, ?, ?)`,
          [conversation_id, userId, message_text || '']
        );

        const messageId = result.insertId;

        // Save attachments if any
        const savedAttachments = [];
        if (attachments && attachments.length > 0) {
          for (const att of attachments) {
            await db.query(
              `INSERT INTO message_attachments (message_id, file_url, file_type, file_name, file_size)
               VALUES (?, ?, ?, ?, ?)`,
              [messageId, att.file_url, att.file_type, att.file_name, att.file_size || null]
            );
            savedAttachments.push(att);
          }
        }

        const messageData = {
          id: messageId,
          conversation_id,
          sender_id: userId,
          sender_name: socket.user.full_name,
          message_text,
          attachments: savedAttachments,
          created_at: new Date().toISOString(),
        };

        // Broadcast to conversation room
        io.to(`conversation:${conversation_id}`).emit('new_message', messageData);

        // Notify the other party via their personal room
        const recipientId = userId === conversation.customer_id
          ? conversation.provider_id
          : conversation.customer_id;

        io.to(`user:${recipientId}`).emit('message_notification', {
          conversation_id,
          order_id: conversation.order_id,
          sender_name: socket.user.full_name,
          message_text: message_text || 'Sent an attachment',
        });
      } catch (error) {
        console.error('Socket send_message error:', error.message);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // ── Typing indicator ────────────────────────────────────
    socket.on('typing', (conversationId) => {
      socket.to(`conversation:${conversationId}`).emit('user_typing', {
        user_id: userId,
        user_name: socket.user.full_name,
      });
    });

    socket.on('stop_typing', (conversationId) => {
      socket.to(`conversation:${conversationId}`).emit('user_stop_typing', {
        user_id: userId,
      });
    });

    // ── Disconnect ──────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`🔌 User disconnected: ${socket.user.full_name} (${userId})`);
    });
  });

  return io;
}

module.exports = { setupSocketIO };
