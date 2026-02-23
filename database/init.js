/**
 * Database initialization script
 * Run: node database/init.js
 *
 * Reads schema.sql and executes it against the configured MySQL server.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function initDatabase() {
  let connection;

  try {
    // Connect without database (we'll create it)
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      multipleStatements: true,
    });

    console.log('📦 Connected to MySQL server');

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    console.log('🔧 Executing schema...');
    await connection.query(schema);

    console.log('✅ Database initialized successfully!');
    console.log('   Database: flupy_db');
    console.log('   Tables created with seed data.');
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
    process.exit(0);
  }
}

initDatabase();
