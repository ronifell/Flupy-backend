require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server: SocketServer } = require('socket.io');
const { testConnection } = require('./config/database');
const { errorHandler } = require('./middleware/errorHandler');
const { setupSocketIO } = require('./socket');
const { initializeFirebase } = require('./config/firebase');

// ── Import Routes ───────────────────────────────────────────
const authRoutes = require('./routes/auth.routes');
const orderRoutes = require('./routes/order.routes');
const providerRoutes = require('./routes/provider.routes');
const chatRoutes = require('./routes/chat.routes');
const ratingRoutes = require('./routes/rating.routes');
const membershipRoutes = require('./routes/membership.routes');
const addressRoutes = require('./routes/address.routes');
const aiRoutes = require('./routes/ai.routes');

// ── Express App ─────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ── Socket.IO ───────────────────────────────────────────────
const io = new SocketServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

setupSocketIO(io);

// ── Middleware ───────────────────────────────────────────────
app.use(cors());

// Stripe webhook must receive raw body BEFORE express.json() parses it
app.use('/api/membership/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
const uploadDir = path.join(__dirname, process.env.UPLOAD_DIR || 'uploads');
app.use('/uploads', express.static(uploadDir));

// Ensure upload directory exists
const fs = require('fs');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ── Routes ──────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/provider', providerRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/membership', membershipRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/ai', aiRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Error Handler ───────────────────────────────────────────
app.use(errorHandler);

// ── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function startServer() {
  const dbReady = await testConnection();
  if (!dbReady) {
    console.warn('⚠️  Starting server without database connection');
  }

  // Initialize Firebase for push notifications
  initializeFirebase();

  server.listen(PORT, () => {
    console.log(`\n🚀 FLUPY API Server running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   API Base: http://localhost:${PORT}/api`);
    console.log(`   Health:   http://localhost:${PORT}/api/health\n`);
  });
}

startServer();

// ── Periodic Membership Expiry Check (every 6 hours) ────────
const { checkExpiringMemberships } = require('./controllers/membership.controller');
setInterval(() => {
  checkExpiringMemberships(null, null);
}, 6 * 60 * 60 * 1000);

module.exports = { app, server, io };
