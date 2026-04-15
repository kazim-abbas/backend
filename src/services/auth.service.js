const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User, Agency } = require('../models');
const AppError = require('../utils/AppError');
const emailService = require('./email.service');
const logger = require('../utils/logger');

// Reset links expire after 1 hour; verification links after 24 hours.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function generateRawToken() {
  // URL-safe, 32 bytes of entropy — plenty for short-lived bearer tokens.
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function buildUrl(path, token) {
  const base = (env.frontendUrl || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

function signToken(user) {
  const payload = {
    sub: user._id.toString(),
    role: user.role,
    agency_id: user.agency_id ? user.agency_id.toString() : null,
  };
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, env.jwtSecret);
  } catch (err) {
    throw AppError.unauthorized('Invalid or expired token');
  }
}

async function register({ email, password, name, role = 'agency', agency_id = null, agencyName }) {
  if (!email || !password) {
    throw AppError.badRequest('email and password are required');
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Creating a new agency inline during signup is a common onboarding path.
  let finalAgencyId = agency_id;
  if (!finalAgencyId && role === 'agency' && agencyName) {
    const agency = await Agency.create({
      name: agencyName,
      slug: slugify(agencyName),
      contact_email: normalizedEmail,
    });
    finalAgencyId = agency._id;
  }

  const existing = await User.findOne({ email: normalizedEmail, agency_id: finalAgencyId });
  if (existing) {
    throw AppError.conflict('A user with this email already exists for this agency');
  }

  const user = new User({
    email: normalizedEmail,
    name: name || '',
    role,
    agency_id: finalAgencyId,
  });
  await user.setPassword(password);

  // Email verification token. The raw token is emailed, only the hash is
  // persisted, so a DB leak cannot be used to verify someone else's email.
  const rawVerifyToken = generateRawToken();
  user.email_verification_token_hash = hashToken(rawVerifyToken);
  user.email_verification_expires = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

  await user.save();

  // Fire-and-forget: never let an email hiccup block signup. We still
  // inspect the result object because emailService.send() catches its own
  // errors internally and returns { sent, skipped, error } — so a .catch()
  // alone would never fire. Log the outcome so Railway logs show whether
  // the mail was actually delivered or silently skipped.
  emailService
    .sendEmailVerification({
      email: user.email,
      name: user.name,
      verifyUrl: buildUrl('/verify-email', rawVerifyToken),
    })
    .then((result) => logEmailOutcome('verification_email', user.email, result))
    .catch((err) =>
      logger.warn('verification_email_send_failed', { error: err.message })
    );

  return { user, token: signToken(user) };
}

// Uniform logging shape for every fire-and-forget transactional email.
// Makes it trivial to grep Railway logs for `"kind":"verification_email"`
// and see all attempts, outcomes, and failure reasons at once.
function logEmailOutcome(kind, recipient, result) {
  if (result?.sent) {
    logger.info('transactional_email_sent', { kind, to: recipient, id: result.id });
  } else if (result?.skipped) {
    logger.warn('transactional_email_skipped', {
      kind,
      to: recipient,
      reason: result.reason || 'unknown',
    });
  } else if (result?.sent === false) {
    logger.error('transactional_email_failed', {
      kind,
      to: recipient,
      error: result.error,
    });
  }
}

/**
 * Kick off a password reset. Always returns a generic success response so
 * attackers cannot enumerate which emails exist in which agency.
 */
async function forgotPassword({ email, agency_slug }) {
  if (!email) throw AppError.badRequest('email is required');
  const normalizedEmail = email.toLowerCase().trim();

  let agencyFilter = { agency_id: null };
  if (agency_slug) {
    const agency = await Agency.findOne({ slug: agency_slug.toLowerCase() });
    // If slug is bogus we still return success — don't leak existence.
    if (!agency) return { ok: true };
    agencyFilter = { agency_id: agency._id };
  }

  const user = await User.findOne({ email: normalizedEmail, ...agencyFilter });
  if (!user || !user.is_active) return { ok: true };

  const rawToken = generateRawToken();
  user.password_reset_token_hash = hashToken(rawToken);
  user.password_reset_expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await user.save();

  emailService
    .sendPasswordResetEmail({
      email: user.email,
      name: user.name,
      resetUrl: buildUrl('/reset-password', rawToken),
    })
    .then((result) => logEmailOutcome('password_reset_email', user.email, result))
    .catch((err) =>
      logger.warn('reset_email_send_failed', { error: err.message })
    );

  return { ok: true };
}

/**
 * Consume a reset token and set the new password. The token is single-use:
 * successful reset clears the hash so it can't be replayed.
 */
async function resetPassword({ token, password }) {
  if (!token || !password) {
    throw AppError.badRequest('token and password are required');
  }
  const tokenHash = hashToken(token);

  const user = await User.findOne({
    password_reset_token_hash: tokenHash,
    password_reset_expires: { $gt: new Date() },
  }).select('+password_reset_token_hash +password_reset_expires +password_hash');

  if (!user) throw AppError.badRequest('Reset link is invalid or expired');

  await user.setPassword(password);
  user.password_reset_token_hash = '';
  user.password_reset_expires = null;
  await user.save();

  return { user, token: signToken(user) };
}

/**
 * Consume an email-verification token. Single-use: clears the hash after.
 */
async function verifyEmail({ token }) {
  if (!token) throw AppError.badRequest('token is required');
  const tokenHash = hashToken(token);

  const user = await User.findOne({
    email_verification_token_hash: tokenHash,
    email_verification_expires: { $gt: new Date() },
  }).select('+email_verification_token_hash +email_verification_expires');

  if (!user) throw AppError.badRequest('Verification link is invalid or expired');

  user.email_verified = true;
  user.email_verification_token_hash = '';
  user.email_verification_expires = null;
  await user.save();

  return { user };
}

/**
 * Resend the email verification link. Mirrors forgotPassword's opaque
 * success behavior to avoid account enumeration.
 */
async function resendVerification({ email, agency_slug }) {
  const normalizedEmail = (email || '').toLowerCase().trim();
  if (!normalizedEmail) throw AppError.badRequest('email is required');

  let agencyFilter = { agency_id: null };
  if (agency_slug) {
    const agency = await Agency.findOne({ slug: agency_slug.toLowerCase() });
    if (!agency) return { ok: true };
    agencyFilter = { agency_id: agency._id };
  }

  const user = await User.findOne({ email: normalizedEmail, ...agencyFilter });
  if (!user || !user.is_active || user.email_verified) return { ok: true };

  const rawToken = generateRawToken();
  user.email_verification_token_hash = hashToken(rawToken);
  user.email_verification_expires = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);
  await user.save();

  emailService
    .sendEmailVerification({
      email: user.email,
      name: user.name,
      verifyUrl: buildUrl('/verify-email', rawToken),
    })
    .then((result) => logEmailOutcome('verification_email_resend', user.email, result))
    .catch((err) =>
      logger.warn('verification_email_send_failed', { error: err.message })
    );

  return { ok: true };
}

async function login({ email, password, agency_slug }) {
  if (!email || !password) {
    throw AppError.badRequest('email and password are required');
  }

  // Scope login to agency when slug is provided; otherwise match admins (agency_id=null).
  let agencyFilter = { agency_id: null };
  if (agency_slug) {
    const agency = await Agency.findOne({ slug: agency_slug.toLowerCase() });
    if (!agency) throw AppError.unauthorized('Invalid credentials');
    agencyFilter = { agency_id: agency._id };
  }

  const user = await User.findOne({ email: email.toLowerCase(), ...agencyFilter }).select('+password_hash');
  if (!user || !user.is_active) throw AppError.unauthorized('Invalid credentials');

  const ok = await user.verifyPassword(password);
  if (!ok) throw AppError.unauthorized('Invalid credentials');

  user.last_login_at = new Date();
  await user.save();

  return { user, token: signToken(user) };
}

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || `agency-${Date.now()}`;
}

module.exports = {
  signToken,
  verifyToken,
  register,
  login,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
};
