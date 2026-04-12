/**
 * Ordo WhatsApp Service — Main Entry Point
 *
 * A standalone Node.js service (deployed on Railway) that:
 * 1. Connects to WhatsApp via whatsapp-web.js
 * 2. Exposes an Express API for sending messages to groups/customers
 * 3. Listens for agent replies in delivery groups and forwards them to Ordo
 * 4. Persists WhatsApp session in PostgreSQL (survives container restarts)
 * 5. Queues messages when WhatsApp is disconnected, flushes on reconnect
 */

const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const qrcode = require("qrcode-terminal");

const { initSessionTable, saveSession, loadSession, deleteSession, pool } = require("./session-store");
const { sendGroupEvent, notifyMessageSent, notifyAgentReply, notifySessionDisconnected } = require("./ordo-api");
const { initQueueTable, enqueue, dequeueAll, queueSize } = require("./message-queue");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3001;
const SECRET = process.env.WHATSAPP_SERVICE_SECRET || "";
const SESSION_ID = "ordo-whatsapp";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let isReady = false;
let qrCodeData = null; // holds latest QR for the /qr endpoint

// ---------------------------------------------------------------------------
// WhatsApp Client
// ---------------------------------------------------------------------------

const client = new Client({
  authStrategy: new LocalAuth({ clientId: SESSION_ID }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  },
});

// ---------------------------------------------------------------------------
// WhatsApp Events
// ---------------------------------------------------------------------------

client.on("qr", (qr) => {
  qrCodeData = qr;
  console.log("[whatsapp] QR code received — scan with WhatsApp:");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("[whatsapp] Authenticated");
  qrCodeData = null;
});

client.on("auth_failure", (msg) => {
  console.error("[whatsapp] Auth failure:", msg);
  qrCodeData = null;
});

client.on("ready", async () => {
  isReady = true;
  qrCodeData = null;
  console.log("[whatsapp] Client ready");

  // Flush any queued messages
  const pending = await queueSize();
  if (pending > 0) {
    console.log(`[whatsapp] Flushing ${pending} queued messages...`);
    await flushQueue();
  }
});

client.on("disconnected", async (reason) => {
  isReady = false;
  console.warn("[whatsapp] Disconnected:", reason);

  // Notify Ordo so admins get an alert
  await notifySessionDisconnected(reason);

  // Try to reconnect after a brief delay
  setTimeout(() => {
    console.log("[whatsapp] Attempting reconnect...");
    client.initialize().catch((err) => {
      console.error("[whatsapp] Reconnect failed:", err.message);
    });
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Incoming message handler — detect agent replies in delivery groups
// ---------------------------------------------------------------------------

client.on("message", async (msg) => {
  try {
    // Only care about group messages
    const chat = await msg.getChat();
    if (!chat.isGroup) return;

    const groupId = chat.id._serialized;

    // Check if this is a quoted reply to a delivery assignment
    if (msg.hasQuotedMsg) {
      const quoted = await msg.getQuotedMessage();
      const quotedBody = quoted.body || "";

      // Our delivery messages start with the delivery emoji heading
      if (quotedBody.includes("DELIVERY ASSIGNMENT")) {
        // Extract order number from the quoted message
        const orderMatch = quotedBody.match(/\*Order:\*\s*(\d+)/);
        if (!orderMatch) return;

        const orderNumber = parseInt(orderMatch[1], 10);
        const contact = await msg.getContact();

        console.log(
          `[whatsapp] Agent reply in group ${groupId} for order #${orderNumber}: "${msg.body}"`,
        );

        await notifyAgentReply({
          orderId: null,
          orderNumber,
          replyText: msg.body,
          quotedMessageId: quoted.id._serialized,
          groupId,
          senderPhone: contact.number,
          senderName: contact.pushname || contact.name || contact.number,
        });

        return;
      }
    }

    // Fallback: scan any group message for an order number reference
    // Pattern: "order 1234" or "#1234" or "Order #1234"
    const orderRefMatch = msg.body.match(/(?:order\s*#?\s*|#)(\d{4,})/i);
    if (orderRefMatch) {
      const orderNumber = parseInt(orderRefMatch[1], 10);
      const contact = await msg.getContact();

      console.log(
        `[whatsapp] Possible order reference in group ${groupId}: order #${orderNumber} — "${msg.body}"`,
      );

      await notifyAgentReply({
        orderId: null,
        orderNumber,
        replyText: msg.body,
        quotedMessageId: null,
        groupId,
        senderPhone: contact.number,
        senderName: contact.pushname || contact.name || contact.number,
      });
    }
  } catch (err) {
    console.error("[whatsapp] Error handling incoming message:", err.message);
  }
});

// ---------------------------------------------------------------------------
// Queue flush
// ---------------------------------------------------------------------------

async function flushQueue() {
  const messages = await dequeueAll();
  let sent = 0;
  let failed = 0;

  for (const row of messages) {
    try {
      const sentMsg = await client.sendMessage(row.chat_id, row.message);
      sent++;

      // If this was for a specific order, notify Ordo with the message ID
      if (row.order_id) {
        await notifyMessageSent(row.order_id, sentMsg.id._serialized);
      }
    } catch (err) {
      console.error(
        `[whatsapp] Failed to send queued message to ${row.chat_id}:`,
        err.message,
      );
      // Re-queue the failed message
      await enqueue(row.chat_id, row.message, row.order_id);
      failed++;
    }
  }

  console.log(`[whatsapp] Queue flush complete: ${sent} sent, ${failed} re-queued`);
}

// ---------------------------------------------------------------------------
// Express API
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Auth middleware
function authMiddleware(req, res, next) {
  if (SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
}

// Health check (no auth — Railway uses this)
app.get("/health", (_req, res) => {
  res.json({
    status: isReady ? "connected" : "disconnected",
    uptime: process.uptime(),
    queueSize: null, // populated below
  });

  // Add queue size async
  queueSize()
    .then((size) => {
      // Already sent response, just log
      if (size > 0) console.log(`[health] Queue size: ${size}`);
    })
    .catch(() => {});
});

// Get QR code (for initial setup / reconnection)
app.get("/qr", (_req, res) => {
  if (isReady) {
    return res.json({ status: "connected", qr: null });
  }
  if (qrCodeData) {
    return res.json({ status: "waiting_for_scan", qr: qrCodeData });
  }
  return res.json({ status: "initializing", qr: null });
});

// ---------------------------------------------------------------------------
// POST /send-to-group — Send a message to a WhatsApp group
// ---------------------------------------------------------------------------

app.post("/send-to-group", authMiddleware, async (req, res) => {
  const { groupId, message, orderId } = req.body;

  if (!groupId || !message) {
    return res.status(400).json({ error: "groupId and message are required" });
  }

  // If WhatsApp is down, queue the message
  if (!isReady) {
    await enqueue(groupId, message, orderId || null);
    console.log(`[api] WhatsApp offline — queued message for group ${groupId}`);
    return res.json({ ok: true, queued: true });
  }

  try {
    const sentMsg = await client.sendMessage(groupId, message);
    const messageId = sentMsg.id._serialized;
    console.log(`[api] Sent to group ${groupId} — msgId: ${messageId}`);

    // If this is tied to an order, notify Ordo with the message ID
    if (orderId) {
      await notifyMessageSent(orderId, messageId);
    }

    return res.json({ ok: true, messageId });
  } catch (err) {
    console.error(`[api] Failed to send to group ${groupId}:`, err.message);

    // Queue it for retry
    await enqueue(groupId, message, orderId || null);
    return res.status(500).json({ error: "Send failed, message queued for retry" });
  }
});

// ---------------------------------------------------------------------------
// POST /send-to-customer — Send a WhatsApp message to a customer
// ---------------------------------------------------------------------------

app.post("/send-to-customer", authMiddleware, async (req, res) => {
  const { phone, message, orderId } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: "phone and message are required" });
  }

  // Format phone to WhatsApp chat ID (strip +, add @c.us)
  const chatId = phone.replace(/[^0-9]/g, "") + "@c.us";

  if (!isReady) {
    await enqueue(chatId, message, orderId || null);
    console.log(`[api] WhatsApp offline — queued message for customer ${chatId}`);
    return res.json({ ok: true, queued: true });
  }

  try {
    const sentMsg = await client.sendMessage(chatId, message);
    console.log(`[api] Sent to customer ${chatId} — msgId: ${sentMsg.id._serialized}`);
    return res.json({ ok: true, messageId: sentMsg.id._serialized });
  } catch (err) {
    console.error(`[api] Failed to send to customer ${chatId}:`, err.message);
    await enqueue(chatId, message, orderId || null);
    return res.status(500).json({ error: "Send failed, message queued for retry" });
  }
});

// ---------------------------------------------------------------------------
// POST /send-bulk — Send a message to multiple recipients
// ---------------------------------------------------------------------------

app.post("/send-bulk", authMiddleware, async (req, res) => {
  const { recipients } = req.body;

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "recipients array is required" });
  }

  const results = [];
  for (const { chatId, message, orderId } of recipients) {
    if (!chatId || !message) {
      results.push({ chatId, ok: false, error: "missing chatId or message" });
      continue;
    }

    if (!isReady) {
      await enqueue(chatId, message, orderId || null);
      results.push({ chatId, ok: true, queued: true });
      continue;
    }

    try {
      const sentMsg = await client.sendMessage(chatId, message);
      results.push({ chatId, ok: true, messageId: sentMsg.id._serialized });

      if (orderId) {
        await notifyMessageSent(orderId, sentMsg.id._serialized);
      }
    } catch (err) {
      await enqueue(chatId, message, orderId || null);
      results.push({ chatId, ok: false, error: err.message, queued: true });
    }
  }

  return res.json({ ok: true, results });
});

// ---------------------------------------------------------------------------
// GET /groups — List all groups this WhatsApp account is in
// ---------------------------------------------------------------------------

app.get("/groups", authMiddleware, async (_req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  try {
    const chats = await client.getChats();
    const groups = chats
      .filter((c) => c.isGroup)
      .map((c) => ({
        id: c.id._serialized,
        name: c.name,
        participantCount: c.participants?.length ?? null,
      }));

    return res.json({ groups });
  } catch (err) {
    console.error("[api] Failed to list groups:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function start() {
  console.log("[ordo-whatsapp] Starting...");

  // Initialize PostgreSQL tables
  await initSessionTable();
  await initQueueTable();

  // Start Express server
  app.listen(PORT, () => {
    console.log(`[ordo-whatsapp] API listening on port ${PORT}`);
  });

  // Initialize WhatsApp client
  console.log("[whatsapp] Initializing client...");
  await client.initialize();
}

start().catch((err) => {
  console.error("[ordo-whatsapp] Fatal error:", err);
  process.exit(1);
});
