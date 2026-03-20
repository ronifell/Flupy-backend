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
const { i18nMiddleware } = require('./i18n');

// ── Import Routes ───────────────────────────────────────────
const authRoutes = require('./routes/auth.routes');
const orderRoutes = require('./routes/order.routes');
const providerRoutes = require('./routes/provider.routes');
const chatRoutes = require('./routes/chat.routes');
const ratingRoutes = require('./routes/rating.routes');
const membershipRoutes = require('./routes/membership.routes');
const addressRoutes = require('./routes/address.routes');
const aiRoutes = require('./routes/ai.routes');
const serviceRoutes = require('./routes/service.routes');
const bloodDonorRoutes = require('./routes/bloodDonor.routes');

// ── Express App ─────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ── Socket.IO ───────────────────────────────────────────────
// Configure CORS based on environment
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : (process.env.NODE_ENV === 'production' ? [] : '*');

const io = new SocketServer(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

setupSocketIO(io);

// ── Middleware ───────────────────────────────────────────────
// CORS configuration for production
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (process.env.NODE_ENV === 'production') {
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    } else {
      // Development: allow all origins
      callback(null, true);
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));

// i18n middleware - must be before routes
app.use(i18nMiddleware);

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
app.use('/api/services', serviceRoutes);
app.use('/api/blood-donor', bloodDonorRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve terms and conditions (for mobile app WebView)
app.get('/terms-and-conditions.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'terms-and-conditions.html'));
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

  // Bind to all interfaces for VPS deployment
  const HOST = process.env.HOST || '0.0.0.0';
  
  server.listen(PORT, HOST, () => {
    const env = process.env.NODE_ENV || 'development';
    const protocol = env === 'production' ? 'https' : 'http';
    const domain = process.env.DOMAIN || `localhost:${PORT}`;
    
    console.log(`\n🚀 FLUPY API Server running on port ${PORT}`);
    console.log(`   Environment: ${env}`);
    console.log(`   Host: ${HOST}`);
    console.log(`   API Base: ${protocol}://${domain}/api`);
    console.log(`   Health:   ${protocol}://${domain}/api/health\n`);
  });
}

startServer();

// ── Periodic Membership Expiry Check (every 6 hours) ────────
const { checkExpiringMemberships } = require('./controllers/membership.controller');
setInterval(() => {
  checkExpiringMemberships(null, null);
}, 6 * 60 * 60 * 1000);

module.exports = { app, server, io };
