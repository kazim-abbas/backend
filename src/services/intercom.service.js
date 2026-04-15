const crypto = require('crypto');
const env = require('../config/env');
const { Agency, User, Ticket } = require('../models');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

/**
 * Verify an Intercom webhook HMAC signature.
 * Intercom sends the signature in `X-Hub-Signature` as `sha1=<hex>` computed
 * over the raw request body using the app's client secret.
 *
 * IMPORTANT: this requires the RAW body — mount the webhook route with
 * express.raw({ type: 'application/json' }) so `req.body` is a Buffer here.
 */
function verifySignature(rawBody, signatureHeader) {
  if (!env.intercom.clientSecret) {
    // Fail closed in production, permissive in dev so local testing works.
    if (env.isProd) return false;
    logger.warn('intercom_client_secret_missing_dev_mode_allow');
    return true;
  }
  if (!signatureHeader) return false;

  const [, provided] = signatureHeader.split('=');
  if (!provided) return false;

  const expected = crypto
    .createHmac('sha1', env.intercom.clientSecret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(provided, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Extract the primary contact from an Intercom conversation payload.
 * Modern Intercom webhooks put the full contact (with custom_attributes)
 * in `contacts.contacts[]`. Older payloads used `user` or `source.author`.
 */
function extractPrimaryContact(conversation) {
  const fromContactsList = conversation?.contacts?.contacts?.[0];
  return (
    fromContactsList ||
    conversation?.user ||
    conversation?.source?.author ||
    null
  );
}

/**
 * Resolve the tenant agency for an Intercom event.
 *
 * Strategy (in priority order):
 *   1. custom_attributes.agency_id on the contact or company (explicit mapping)
 *   2. company.company_id matching an Agency _id (recommended: use Agency _id as Intercom company_id)
 *   3. app_id → Agency.intercom_app_id
 */
async function resolveAgencyFromEvent(data) {
  const conversation = data?.item || data;
  const contact = extractPrimaryContact(conversation);
  const company =
    contact?.companies?.companies?.[0] || contact?.companies?.[0];

  // 1. Explicit custom attribute (works for Leads)
  const customAgencyId =
    contact?.custom_attributes?.agency_id ||
    company?.custom_attributes?.agency_id;
  if (customAgencyId) {
    const byCustom = await Agency.findById(customAgencyId).catch(() => null);
    if (byCustom) return byCustom;
    logger.warn('intercom_agency_id_cda_no_match', {
      custom_agency_id: customAgencyId,
    });
  }

  // 2. Intercom company_id === Agency _id (requires identified User, not Lead)
  if (company?.company_id) {
    const byCompany = await Agency.findById(company.company_id).catch(() => null);
    if (byCompany) return byCompany;
  }

  // 3. App-level fallback
  const appId = data?.app_id;
  if (appId) {
    const byApp = await Agency.findOne({ intercom_app_id: appId });
    if (byApp) return byApp;
  }

  // Nothing matched — dump enough of the payload to debug.
  logger.warn('intercom_event_resolver_debug', {
    has_contacts_list: Boolean(conversation?.contacts?.contacts?.length),
    has_user: Boolean(conversation?.user),
    has_source_author: Boolean(conversation?.source?.author),
    contact_type: contact?.type,
    contact_custom_attributes: contact?.custom_attributes || null,
    company_id_on_contact: company?.company_id || null,
    app_id: data?.app_id || null,
  });

  return null;
}

/**
 * Upsert a lightweight client user record for Intercom-originated contacts.
 * These users have role "client" and are scoped to the resolved agency.
 */
async function upsertClientUser({ agency, intercomUser }) {
  if (!intercomUser) return null;
  const email = (intercomUser.email || '').toLowerCase().trim();
  const intercom_user_id = intercomUser.user_id || intercomUser.id || '';

  const filter = email
    ? { email, agency_id: agency._id }
    : { intercom_user_id, agency_id: agency._id };

  let user = await User.findOne(filter);
  if (!user) {
    user = new User({
      email: email || `intercom-${intercom_user_id}@placeholder.local`,
      name: intercomUser.name || '',
      role: 'client',
      agency_id: agency._id,
      intercom_user_id,
    });
    // Intercom-originated users don't have passwords; set a random unusable one.
    await user.setPassword(crypto.randomBytes(24).toString('hex'));
    await user.save();
  } else if (intercom_user_id && !user.intercom_user_id) {
    user.intercom_user_id = intercom_user_id;
    await user.save();
  }
  return user;
}

/**
 * Extract the messages from an Intercom conversation payload into our
 * internal schema. Intercom conversations have `source` (the initial message)
 * plus `conversation_parts.conversation_parts[]` for replies.
 */
function extractMessages(conversation) {
  const messages = [];

  if (conversation?.source?.body) {
    messages.push({
      sender: senderType(conversation.source.author?.type),
      sender_id: conversation.source.author?.id || '',
      sender_name: conversation.source.author?.name || '',
      text: stripHtml(conversation.source.body),
      intercom_part_id: conversation.source.id || '',
      timestamp: conversation.created_at
        ? new Date(conversation.created_at * 1000)
        : new Date(),
    });
  }

  const parts =
    conversation?.conversation_parts?.conversation_parts ||
    conversation?.conversation_parts ||
    [];
  for (const part of parts) {
    if (!part?.body) continue;
    messages.push({
      sender: senderType(part.author?.type),
      sender_id: part.author?.id || '',
      sender_name: part.author?.name || '',
      text: stripHtml(part.body),
      intercom_part_id: part.id || '',
      timestamp: part.created_at ? new Date(part.created_at * 1000) : new Date(),
    });
  }

  return messages;
}

function senderType(intercomAuthorType) {
  // Intercom author.type values: "user", "admin", "bot", "contact"
  if (intercomAuthorType === 'admin' || intercomAuthorType === 'teammate') return 'agent';
  if (intercomAuthorType === 'bot') return 'ai';
  return 'user';
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Main dispatch: handle a verified Intercom webhook event. Idempotent — uses
 * the conversation id as the natural key so replays don't create duplicates.
 */
async function handleEvent(event) {
  const topic = event?.topic;
  const data = event?.data || {};
  const conversation = data.item || {};

  const agency = await resolveAgencyFromEvent(data);
  if (!agency) {
    logger.warn('intercom_event_no_agency_match', { topic, conversation_id: conversation.id });
    return { status: 'ignored', reason: 'agency_not_resolved' };
  }

  const intercomConversationId = conversation.id;
  if (!intercomConversationId) {
    logger.warn('intercom_event_missing_conversation_id', { topic });
    return { status: 'ignored', reason: 'no_conversation_id' };
  }

  const intercomUser = extractPrimaryContact(conversation);
  const user = await upsertClientUser({ agency, intercomUser });
  if (!user) {
    logger.warn('intercom_event_no_user', { topic, conversation_id: intercomConversationId });
    return { status: 'ignored', reason: 'user_not_resolved' };
  }

  const messages = extractMessages(conversation);

  // Upsert the ticket. For replies, we merge new messages by intercom_part_id.
  let ticket = await Ticket.findOne({
    agency_id: agency._id,
    intercom_conversation_id: intercomConversationId,
  });

  if (!ticket) {
    ticket = await Ticket.create({
      intercom_conversation_id: intercomConversationId,
      agency_id: agency._id,
      user_id: user._id,
      subject: conversation.source?.subject || '',
      messages,
      status: statusFromIntercom(conversation.state),
      last_message_at:
        messages[messages.length - 1]?.timestamp || new Date(),
    });
  } else {
    const existingIds = new Set(ticket.messages.map((m) => m.intercom_part_id).filter(Boolean));
    const newOnes = messages.filter(
      (m) => !m.intercom_part_id || !existingIds.has(m.intercom_part_id)
    );
    if (newOnes.length) {
      ticket.messages.push(...newOnes);
      ticket.last_message_at = newOnes[newOnes.length - 1].timestamp;
    }
    ticket.status = statusFromIntercom(conversation.state) || ticket.status;
    await ticket.save();
  }

  logger.info('intercom_event_handled', {
    topic,
    agency_id: agency._id.toString(),
    ticket_id: ticket._id.toString(),
    messages_in_event: messages.length,
  });

  return {
    status: 'ok',
    ticket_id: ticket._id.toString(),
    agency_id: agency._id.toString(),
    topic,
  };
}

function statusFromIntercom(state) {
  if (!state) return null;
  if (state === 'open') return 'open';
  if (state === 'closed') return 'resolved';
  if (state === 'snoozed') return 'pending';
  return 'open';
}

module.exports = {
  verifySignature,
  handleEvent,
  resolveAgencyFromEvent,
  extractMessages,
};
