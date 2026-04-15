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
  sendTokenUsageWarning,
  sendPasswordResetEmail,
  sendSignupOtp,
};
