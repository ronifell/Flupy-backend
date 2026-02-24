/**
 * PM2 Ecosystem Configuration
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup
 */

module.exports = {
  apps: [{
    name: 'flupy-backend',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    
    // Environment variables
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    
    // Logging
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Auto-restart configuration
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    
    // Advanced settings
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 4000,
    
    // Graceful shutdown
    kill_timeout: 5000,
    listen_timeout: 3000,
  }]
};
