const intercomService = require('../services/intercom.service');
const emailService = require('../services/email.service');
const logger = require('../utils/logger');
const { Agency, Ticket } = require('../models');

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

      // Fire-and-forget notifications for new conversations.
      if (result?.status === 'ok' && result.topic === 'conversation.user.created') {
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
    } catch (err) {
      logger.error('intercom_event_processing_failed', {
        error: err.message,
        stack: err.stack,
      });
    }
  });
}

module.exports = { handleIntercom };
