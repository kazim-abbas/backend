const env = require('../config/env');
const logger = require('../utils/logger');

let resendClient = null;
let startupChecked = false;

function getClient() {
  if (!env.resend.apiKey) return null;
  if (!resendClient) {
    const { Resend } = require('resend');
    resendClient = new Resend(env.resend.apiKey);
  }
  return resendClient;
}

/**
 * Run once, the first time anyone tries to send. Surface misconfiguration
 * early and loudly in logs rather than silently swallowing every send.
 *
 * Resend rejects any `from` address on a domain you haven't verified in
 * the Resend dashboard — so the default placeholder
 * `notifications@example.com` will ALWAYS fail delivery in prod. Warn
 * aggressively so operators notice before users complain.
 */
function checkConfigOnce() {
  if (startupChecked) return;
  startupChecked = true;

  if (!env.resend.apiKey) {
    logger.warn('email_misconfigured', {
      issue: 'RESEND_API_KEY not set — all emails will be skipped',
    });
    return;
  }
  if (!env.resend.fromEmail || env.resend.fromEmail === 'notifications@example.com') {
    logger.warn('email_misconfigured', {
      issue:
        'RESEND_FROM_EMAIL is empty or the placeholder default — Resend will reject sends. Set it to an address on a verified Resend domain.',
      current: env.resend.fromEmail,
    });
  }
}

/**
 * Best-effort send. Never throws — email failure should not break the
 * request path. Every send is logged, including skip/failure reasons, so
 * that prod issues are diagnosable from logs alone.
 *
 * Returns one of:
 *   { sent: true,  id }             on success
 *   { sent: false, error }          on failure (API rejection or thrown error)
 *   { skipped: true, reason }       when config/input prevented the send
 */
async function send({ to, subject, html, text }) {
  checkConfigOnce();

  if (!env.resend.apiKey) {
    logger.warn('email_send_skipped', { to, subject, reason: 'no_api_key' });
    return { skipped: true, reason: 'no_api_key' };
  }
  if (!to) {
    logger.warn('email_send_skipped', { subject, reason: 'no_recipient' });
    return { skipped: true, reason: 'no_recipient' };
  }
  if (!env.resend.fromEmail) {
    logger.error('email_send_skipped', { to, subject, reason: 'no_from_email' });
    return { skipped: true, reason: 'no_from_email' };
  }

  const client = getClient();

  try {
    // Resend SDK returns { data, error }: it does NOT throw on API errors,
    // so we must check `error` explicitly. Only unexpected exceptions
    // (network, SDK bug) reach the catch block.
    const result = await client.emails.send({
      from: env.resend.fromEmail,
      to,
      subject,
      html,
      text,
    });

    if (result?.error) {
      // Common failure shape: { statusCode, message, name }
      const errMsg = result.error.message || result.error.name || 'unknown resend error';
      logger.error('email_send_failed', {
        to,
        subject,
        from: env.resend.fromEmail,
        statusCode: result.error.statusCode,
        name: result.error.name,
        error: errMsg,
      });
      return { sent: false, error: errMsg };
    }

    logger.info('email_sent', { to, subject, id: result?.data?.id });
    return { sent: true, id: result?.data?.id };
  } catch (err) {
    logger.error('email_send_failed', {
      to,
      subject,
      from: env.resend.fromEmail,
      error: err.message,
      stack: err.stack,
    });
    return { sent: false, error: err.message };
  }
}

async function sendNewTicketAlert({ agency, ticket, recipientEmail }) {
  if (!recipientEmail && !agency?.contact_email) return { skipped: true, reason: 'no_recipient' };
  return send({
    to: recipientEmail || agency.contact_email,
    subject: `[${agency.name}] New support ticket`,
    text: `A new support ticket was created.\n\nTicket ID: ${ticket._id}\nSubject: ${ticket.subject || '(no subject)'}`,
    html: `
      <h2>New support ticket</h2>
      <p><strong>Agency:</strong> ${escapeHtml(agency.name)}</p>
      <p><strong>Ticket:</strong> ${ticket._id}</p>
      <p><strong>Subject:</strong> ${escapeHtml(ticket.subject || '(no subject)')}</p>
    `,
  });
}

async function sendReplyNotification({ agency, ticket, recipientEmail, replyText }) {
  if (!recipientEmail) return { skipped: true, reason: 'no_recipient' };
  return send({
    to: recipientEmail,
    subject: `[${agency.name}] New reply on your ticket`,
    text: `You have a new reply:\n\n${replyText}`,
    html: `<h2>New reply on your ticket</h2><p>${escapeHtml(replyText)}</p>`,
  });
}

async function sendPasswordResetEmail({ email, name, resetUrl }) {
  if (!email) return { skipped: true, reason: 'no_recipient' };
  return send({
    to: email,
    subject: 'Reset your password',
    text: `Hi ${name || 'there'},

You (or someone using this email) asked to reset your password. Click the link below to set a new one:

${resetUrl}

If you didn't request a reset, you can safely ignore this email — your password will not change.

This link expires in 1 hour.`,
    html: `
      <p>Hi ${escapeHtml(name || 'there')},</p>
      <p>You (or someone using this email) asked to reset your password. Click the button below to set a new one:</p>
      <p>
        <a href="${escapeHtml(resetUrl)}"
           style="display:inline-block;padding:10px 16px;border-radius:6px;background:#5b8def;color:#fff;text-decoration:none;">
          Reset password
        </a>
      </p>
      <p style="font-size:12px;color:#666;">Or paste this link into your browser:<br/>
        <span style="word-break:break-all;">${escapeHtml(resetUrl)}</span>
      </p>
      <p style="font-size:12px;color:#666;">If you didn't request a reset, you can safely ignore this email — your password will not change. This link expires in 1 hour.</p>
    `,
  });
}

/**
 * Signup OTP email. The code is the whole payload — there is no link to
 * click, which sidesteps link-prefetch attacks, deliverability quirks from
 * security scanners that "open" URLs, and the usual broken-email-client
 * issues. The HTML renders the 6 digits in a large monospace block for
 * easy copy / read-aloud.
 */
async function sendSignupOtp({ email, name, code, ttlMinutes = 15 }) {
  if (!email) return { skipped: true, reason: 'no_recipient' };
  if (!code) return { skipped: true, reason: 'no_code' };
  return send({
    to: email,
    subject: `Your verification code: ${code}`,
    text: `Hi ${name || 'there'},

Your verification code is:

    ${code}

Enter this code on the verification page to finish creating your account.

This code expires in ${ttlMinutes} minutes. If you didn't start a signup, you can safely ignore this email.`,
    html: `
      <p>Hi ${escapeHtml(name || 'there')},</p>
      <p>Your verification code is:</p>
      <p style="margin:24px 0;text-align:center;">
        <span style="display:inline-block;padding:16px 24px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:32px;letter-spacing:8px;background:#f4f6fb;border:1px solid #d9dde6;border-radius:8px;color:#1a1a1a;">
          ${escapeHtml(String(code))}
        </span>
      </p>
      <p>Enter this code on the verification page to finish creating your account.</p>
      <p style="font-size:12px;color:#666;">This code expires in ${ttlMinutes} minutes. If you didn't start a signup, you can safely ignore this email.</p>
    `,
  });
}

/**
 * Email the full conversation transcript to the agency when a ticket is
 * closed. Includes every message with sender, role, timestamp, and body.
 *
 * Sends plain text and HTML. The HTML uses inline styles only (email clients
 * strip <style> tags) with a light role-based background so the sender is
 * scannable at a glance.
 */
async function sendClosedTicketTranscript({ agency, ticket, recipientEmail }) {
  const to = recipientEmail || agency?.contact_email;
  if (!to) return { skipped: true, reason: 'no_recipient' };
  if (!ticket) return { skipped: true, reason: 'no_ticket' };

  const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
  const subjectLine = ticket.subject || `Ticket ${ticket._id}`;

  const roleLabel = (sender) => {
    if (sender === 'agent') return 'Agent';
    if (sender === 'ai') return 'AI assistant';
    if (sender === 'system') return 'System';
    return 'Customer';
  };

  // Plain-text transcript. Kept in a predictable format so it reads cleanly
  // in text-only mail clients and can be grepped if forwarded.
  const textBody = messages.length
    ? messages
        .map((m) => {
          const when = new Date(m.timestamp).toISOString();
          const who = m.sender_name || roleLabel(m.sender);
          return `[${when}] ${who} (${roleLabel(m.sender)})\n${m.text}\n`;
        })
        .join('\n')
    : '(no messages)';

  const bgForSender = (sender) => {
    if (sender === 'agent') return '#eaf2ff';
    if (sender === 'ai') return '#ecfbee';
    if (sender === 'system') return '#f4f4f4';
    return '#f8f8f8';
  };
  const borderForSender = (sender) => {
    if (sender === 'agent') return '#5b8def';
    if (sender === 'ai') return '#4caf50';
    if (sender === 'system') return '#999999';
    return '#d0d0d0';
  };

  const htmlMessages = messages.length
    ? messages
        .map((m) => {
          const who = escapeHtml(m.sender_name || roleLabel(m.sender));
          const role = escapeHtml(roleLabel(m.sender));
          const when = escapeHtml(new Date(m.timestamp).toLocaleString());
          return `
            <div style="margin:12px 0;padding:12px 14px;border-radius:6px;background:${bgForSender(
              m.sender
            )};border-left:3px solid ${borderForSender(m.sender)};">
              <div style="font-size:12px;color:#555;margin-bottom:6px;">
                <strong>${who}</strong>
                <span style="text-transform:uppercase;letter-spacing:0.5px;color:#888;margin-left:6px;">${role}</span>
                <span style="float:right;">${when}</span>
              </div>
              <div style="white-space:pre-wrap;color:#1a1a1a;">${escapeHtml(m.text || '')}</div>
            </div>
          `;
        })
        .join('')
    : '<p><em>(no messages)</em></p>';

  return send({
    to,
    subject: `[${agency?.name || 'Support'}] Ticket closed: ${subjectLine}`,
    text: `Ticket closed
Agency: ${agency?.name || ''}
Subject: ${subjectLine}
Ticket ID: ${ticket._id}
Messages: ${messages.length}

--- Conversation ---

${textBody}
`,
    html: `
      <h2 style="margin:0 0 8px 0;">Ticket closed</h2>
      <p style="margin:4px 0;"><strong>Agency:</strong> ${escapeHtml(agency?.name || '')}</p>
      <p style="margin:4px 0;"><strong>Subject:</strong> ${escapeHtml(subjectLine)}</p>
      <p style="margin:4px 0;"><strong>Ticket ID:</strong> ${escapeHtml(String(ticket._id))}</p>
      <p style="margin:4px 0;"><strong>Messages:</strong> ${messages.length}</p>
      <hr style="border:none;border-top:1px solid #e5e5e5;margin:16px 0;" />
      <h3 style="margin:0 0 8px 0;">Conversation</h3>
      ${htmlMessages}
    `,
  });
}

async function sendTokenUsageWarning({ agency, percent }) {
  if (!agency?.contact_email) return { skipped: true, reason: 'no_recipient' };
  return send({
    to: agency.contact_email,
    subject: `[${agency.name}] AI token usage at ${Math.round(percent * 100)}%`,
    text: `Your AI token usage has reached ${Math.round(percent * 100)}% of your plan limit.`,
    html: `<p>Your AI token usage has reached <strong>${Math.round(
      percent * 100
    )}%</strong> of your plan limit. Consider upgrading to avoid service interruption.</p>`,
  });
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  send,
  sendNewTicketAlert,
  sendReplyNotification,
  sendClosedTicketTranscript,
  sendTokenUsageWarning,
  sendPasswordResetEmail,
  sendSignupOtp,
};
