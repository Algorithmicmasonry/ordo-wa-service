/**
 * Ordo API client — sends events to the main Ordo app.
 */

const ORDO_API_URL = process.env.ORDO_API_URL || "https://ordocrm.vercel.app";
const SECRET = process.env.WHATSAPP_SERVICE_SECRET || "";

/**
 * POST an event to Ordo's WhatsApp group event endpoint.
 */
async function sendGroupEvent(event) {
  const url = `${ORDO_API_URL}/api/whatsapp/group-event`;
  console.log(`[ordo-api] POST ${url} type=${event.type}`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify(event),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(`[ordo-api] Error ${res.status}:`, data);
      return { ok: false, status: res.status, data };
    }

    console.log(`[ordo-api] Success:`, data);
    return { ok: true, data };
  } catch (err) {
    console.error(`[ordo-api] Network error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Notify Ordo that a message was sent to a group (returns message ID for reply tracking).
 */
async function notifyMessageSent(orderId, messageId) {
  return sendGroupEvent({
    type: "message_sent",
    orderId,
    messageId,
  });
}

/**
 * Notify Ordo of an agent reply in a group.
 */
async function notifyAgentReply({
  orderId,
  orderNumber,
  replyText,
  quotedMessageId,
  groupId,
  senderPhone,
  senderName,
}) {
  return sendGroupEvent({
    type: "agent_reply",
    orderId,
    orderNumber,
    replyText,
    quotedMessageId,
    groupId,
    senderPhone,
    senderName,
  });
}

/**
 * Notify Ordo that the WhatsApp session has disconnected.
 */
async function notifySessionDisconnected(reason) {
  const url = `${ORDO_API_URL}/api/whatsapp/group-event`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        type: "session_disconnected",
        reason,
      }),
    });
  } catch (err) {
    console.error(`[ordo-api] Failed to notify session disconnect:`, err.message);
  }
}

module.exports = {
  sendGroupEvent,
  notifyMessageSent,
  notifyAgentReply,
  notifySessionDisconnected,
};
