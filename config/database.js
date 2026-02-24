const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'flupy_db',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

/**
 * Execute a query with parameters
 * Automatically converts undefined values to null to prevent mysql2 errors
 */
async function query(sql, params = []) {
  const safeParams = params.map(p => (p === undefined ? null : p));
  const [rows] = await pool.execute(sql, safeParams);
  return rows;
}

/**
 * Get a connection from the pool (for transactions)
 */
async function getConnection() {
  return pool.getConnection();
}

/**
 * Test database connection
 */
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Database connected successfully');
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

module.exports = { pool, query, getConnection, testConnection };
