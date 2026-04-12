/**
 * PostgreSQL session store for whatsapp-web.js
 *
 * Saves/loads WhatsApp session data to/from PostgreSQL so the service
 * can reconnect without QR scanning after container restarts.
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const TABLE = "whatsapp_sessions";

/**
 * Create the sessions table if it doesn't exist.
 */
async function initSessionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("[session-store] Table ready");
}

/**
 * Save session data.
 */
async function saveSession(id, data) {
  const json = JSON.stringify(data);
  await pool.query(
    `INSERT INTO ${TABLE} (id, data, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
    [id, json]
  );
}

/**
 * Load session data. Returns null if not found.
 */
async function loadSession(id) {
  const result = await pool.query(
    `SELECT data FROM ${TABLE} WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return JSON.parse(result.rows[0].data);
}

/**
 * Delete session data.
 */
async function deleteSession(id) {
  await pool.query(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
}

module.exports = {
  initSessionTable,
  saveSession,
  loadSession,
  deleteSession,
  pool,
};
