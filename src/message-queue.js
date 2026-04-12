/**
 * Simple in-memory message queue with PostgreSQL backup.
 *
 * When WhatsApp is disconnected, messages are queued.
 * When it reconnects, queued messages are sent.
 */

const { pool } = require("./session-store");

const TABLE = "whatsapp_message_queue";

async function initQueueTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message TEXT NOT NULL,
      order_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("[message-queue] Table ready");
}

async function enqueue(chatId, message, orderId = null) {
  await pool.query(
    `INSERT INTO ${TABLE} (chat_id, message, order_id) VALUES ($1, $2, $3)`,
    [chatId, message, orderId]
  );
  console.log(`[message-queue] Queued message for ${chatId} (order: ${orderId})`);
}

async function dequeueAll() {
  const result = await pool.query(
    `DELETE FROM ${TABLE} RETURNING *`
  );
  return result.rows;
}

async function queueSize() {
  const result = await pool.query(`SELECT COUNT(*) FROM ${TABLE}`);
  return parseInt(result.rows[0].count, 10);
}

module.exports = {
  initQueueTable,
  enqueue,
  dequeueAll,
  queueSize,
};
