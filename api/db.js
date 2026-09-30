require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

module.exports = { pool, uid };
