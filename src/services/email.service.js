const env = require('../config/env');
const logger = require('../utils/logger');

let resendClient = null;
function getClient() {
  if (!env.resend.apiKey) return null;
  if (!resendClient) {
    const { Resend } = require('resend');
    resendClient = new Resend(env.resend.apiKey);
  }
  return resendClient;
}

/**
 * Best-effort send. Never throws — email failure should not break the
 * request path. All sends are logged.
 */
async function send({ to, subject, html, text }) {
  const client = getClient();
  if (!client) {
    logger.warn('email_send_skipped_no_api_key', { to, subject });
    return { skipped: true };
  }
  if (!to) {
    logger.warn('email_send_skipped_no_recipient', { subject });
    return { skipped: true };
  }

  try {
    const result = await client.emails.send({
      from: env.resend.fromEmail,
      to,
      subject,
      html,
      text,
    });
    logger.info('email_sent', { to, subject, id: result?.data?.id });
    return { sent: true, id: result?.data?.id };
  } catch (err) {
    logger.error('email_send_failed', { to, subject, error: err.message });
    return { sent: false, error: err.message };
  }
}

async function sendNewTicketAlert({ agency, ticket, recipientEmail }) {
  if (!recipientEmail && !agency?.contact_email) return { skipped: true };
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
  if (!recipientEmail) return { skipped: true };
  return send({
    to: recipientEmail,
    subject: `[${agency.name}] New reply on your ticket`,
    text: `You have a new reply:\n\n${replyText}`,
    html: `<h2>New reply on your ticket</h2><p>${escapeHtml(replyText)}</p>`,
  });
}

async function sendPasswordResetEmail({ email, name, resetUrl }) {
  if (!email) return { skipped: true };
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

async function sendEmailVerification({ email, name, verifyUrl }) {
  if (!email) return { skipped: true };
  return send({
    to: email,
    subject: 'Verify your email',
    text: `Hi ${name || 'there'},

Welcome! Please confirm your email address by opening the link below:

${verifyUrl}

This link expires in 24 hours.`,
    html: `
      <p>Hi ${escapeHtml(name || 'there')},</p>
      <p>Welcome! Please confirm your email address by clicking the button below:</p>
      <p>
        <a href="${escapeHtml(verifyUrl)}"
           style="display:inline-block;padding:10px 16px;border-radius:6px;background:#5b8def;color:#fff;text-decoration:none;">
          Verify email
        </a>
      </p>
      <p style="font-size:12px;color:#666;">Or paste this link into your browser:<br/>
        <span style="word-break:break-all;">${escapeHtml(verifyUrl)}</span>
      </p>
      <p style="font-size:12px;color:#666;">This link expires in 24 hours.</p>
    `,
  });
}

async function sendTokenUsageWarning({ agency, percent }) {
  if (!agency?.contact_email) return { skipped: true };
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
  sendEmailVerification,
};
