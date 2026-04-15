const intercomService = require('../services/intercom.service');
const emailService = require('../services/email.service');
const aiService = require('../services/ai.service');
const logger = require('../utils/logger');
const { Agency, Ticket, AdminSettings } = require('../models');

// Topics that represent a fresh inbound message from the end user — these
// are the events that may warrant an AI auto-reply.
const USER_MESSAGE_TOPICS = new Set([
  'conversation.user.created',
  'conversation.user.replied',
]);

/**
 * Intercom webhook entry point.
 *
 * This route is mounted with express.raw({type: 'application/json'}) so
 * `req.body` is a Buffer here. Signature verification runs on the raw bytes
 * before we parse JSON.
 */
async function handleIntercom(req, res) {
  const rawBody = req.body; // Buffer
  const signature = req.headers['x-hub-signature'];

  if (!intercomService.verifySignature(rawBody, signature)) {
    logger.warn('intercom_signature_invalid');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.warn('intercom_body_parse_failed', { error: err.message });
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Respond to Intercom immediately — retry storms on slow acks are a real risk.
  // We kick the actual handling async and return 200 right away.
  res.status(200).json({ received: true });

  setImmediate(async () => {
    try {
      const result = await intercomService.handleEvent(event);
      if (result?.status !== 'ok') return;

      const topic = result.topic;

      // Fire-and-forget notifications for new conversations.
      if (topic === 'conversation.user.created') {
        const [agency, ticket] = await Promise.all([
          Agency.findById(result.agency_id).catch(() => null),
          Ticket.findById(result.ticket_id).select('subject').lean().catch(() => null),
        ]);
        if (agency) {
          await emailService.sendNewTicketAlert({
            agency,
            ticket: { _id: result.ticket_id, subject: ticket?.subject || '' },
          });
        }
      }

      // AI auto-reply pass. Only for inbound user messages. Gated by the
      // full AI allow-chain inside generateAutoReply; any failure falls
      // through to silent log + human handling.
      if (USER_MESSAGE_TOPICS.has(topic)) {
        await maybeAutoReply({
          ticketId: result.ticket_id,
          agencyId: result.agency_id,
        });
      }
    } catch (err) {
      logger.error('intercom_event_processing_failed', {
        error: err.message,
        stack: err.stack,
      });
    }
  });
}

/**
 * Generate an AI reply for a freshly-updated ticket and push it to Intercom.
 * On handoff, posts an internal note and leaves the conversation assigned
 * to the default admin so a human picks it up.
 */
async function maybeAutoReply({ ticketId, agencyId }) {
  const [ticket, agency, adminSettings] = await Promise.all([
    Ticket.findById(ticketId),
    Agency.findById(agencyId),
    AdminSettings.getSingleton(),
  ]);
  if (!ticket || !agency) return;

  // Gate: must have auto_reply globally on, agency-level on, and AI enabled.
  if (!adminSettings?.ai_enabled_global) return;
  if (adminSettings.features?.auto_reply === false) return;
  if (!agency.ai_enabled) return;
  if (agency.features?.auto_reply === false) return;

  // Don't stomp on a human reply. If the last message isn't from the user,
  // something else has already responded — skip.
  const lastMessage = ticket.messages[ticket.messages.length - 1];
  if (!lastMessage || lastMessage.sender !== 'user') return;

  let result;
  try {
    result = await aiService.generateAutoReply({ ticket, agency });
  } catch (err) {
    // Gating errors (e.g. token budget exceeded) come through here. Log
    // and let a human handle it — never crash the webhook.
    logger.warn('ai_autoreply_skipped', {
      ticket_id: ticketId,
      reason: err.message,
    });
    return;
  }

  if (!result) return;

  if (result.handoff) {
    // Stamp an internal note so the human agent has context, then leave
    // the conversation alone (don't send a bot reply on handoff).
    if (ticket.intercom_conversation_id) {
      await intercomService.addNoteToIntercom({
        conversationId: ticket.intercom_conversation_id,
        body: `AI handoff (${result.handoff_reason || 'no_match'}): a human agent should take over. Last user message: "${escapeForNote(
          [...ticket.messages].reverse().find((m) => m.sender === 'user')?.text || ''
        )}"`,
      });
      // Flip the conversation to "open" and assign to the default admin so
      // it surfaces in the human inbox.
      await intercomService.assignConversation({
        conversationId: ticket.intercom_conversation_id,
      });
    }
    logger.info('ai_autoreply_handoff', {
      ticket_id: ticketId,
      reason: result.handoff_reason,
    });
    return;
  }

  // Real AI reply: push to Intercom and mirror locally.
  if (ticket.intercom_conversation_id) {
    const sendResult = await intercomService.sendAdminReplyToIntercom({
      conversationId: ticket.intercom_conversation_id,
      body: result.reply,
    });

    let intercomPartId = '';
    if (sendResult.ok) {
      const parts =
        sendResult.json?.conversation_parts?.conversation_parts ||
        sendResult.json?.conversation_parts ||
        [];
      intercomPartId = parts[parts.length - 1]?.id || '';
    } else {
      logger.warn('ai_autoreply_intercom_send_failed', {
        ticket_id: ticketId,
        reason: sendResult.reason || sendResult.status,
      });
    }

    ticket.messages.push({
      sender: 'ai',
      sender_id: 'ai-bot',
      sender_name: 'AI Assistant',
      text: result.reply,
      intercom_part_id: intercomPartId,
      timestamp: new Date(),
    });
    ticket.last_message_at = new Date();
    await ticket.save();
  }

  logger.info('ai_autoreply_sent', {
    ticket_id: ticketId,
    used_articles: result.used_articles?.length || 0,
  });
}

function escapeForNote(s = '') {
  return String(s).slice(0, 300).replace(/"/g, "'");
}

module.exports = { handleIntercom };
