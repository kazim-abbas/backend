const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User, Agency, PendingSignup } = require('../models');
const AppError = require('../utils/AppError');
const emailService = require('./email.service');
const logger = require('../utils/logger');

// --- TTLs -------------------------------------------------------------------
// Reset links expire after 1 hour; signup OTPs after 15 min. Short OTP TTL
// limits the brute-force window; 15 min is still long enough for a user to
// switch to their mail client and type the code.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const SIGNUP_OTP_TTL_MS = 15 * 60 * 1000;
const SIGNUP_OTP_MAX_ATTEMPTS = 5;

// --- Token / OTP helpers ----------------------------------------------------
function generateRawToken() {
  // URL-safe, 32 bytes of entropy — plenty for short-lived bearer tokens.
  return crypto.randomBytes(32).toString('hex');
}

function generateOtp() {
  // 6-digit numeric OTP. randomInt is cryptographically secure. Zero-padded
  // so codes starting with 0 display correctly in the email.
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
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

// --- Signup OTP flow --------------------------------------------------------
// The pattern deliberately avoids creating a User record until the OTP
// verifies. This means:
//   - A typo'd or hostile email can't create zombie accounts.
//   - Unverified users don't sit in the Users collection forever.
//   - Email enumeration on `/register` is harder because nothing persists
//     on the user-facing collection until the code matches.

/**
 * Stage 1 of signup: stash the payload + OTP in PendingSignup, email the
 * code. No User or Agency is written yet.
 *
 * Returns { email } opaquely; callers should not tell the client whether
 * the email was already in use — the verify step handles that race.
 */
async function requestSignupOtp({ email, password, name, role = 'agency', agency_id = null, agencyName }) {
  if (!email || !password) {
    throw AppError.badRequest('email and password are required');
  }
  if (password.length < 8) {
    throw AppError.badRequest('password must be at least 8 characters');
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Fast-fail obvious conflicts. We still rely on the unique index at
  // verify time, but catching this early gives a clearer error to honest
  // users who simply forgot they already have an account.
  const agencyFilter = agency_id ? { agency_id } : { agency_id: null };
  const existing = await User.findOne({ email: normalizedEmail, ...agencyFilter });
  if (existing) {
    throw AppError.conflict('An account with this email already exists. Try signing in instead.');
  }

  // Pre-hash the password now so the plaintext is never persisted — even
  // in the pending record. bcrypt cost 12 matches User.setPassword.
  const salt = await bcrypt.genSalt(12);
  const password_hash = await bcrypt.hash(password, salt);

  const otp = generateOtp();
  const otp_hash = hashToken(otp);
  const expires_at = new Date(Date.now() + SIGNUP_OTP_TTL_MS);

  // Upsert: if the user hits "Register" twice with the same email (e.g.
  // didn't get the first code), replace the pending record rather than
  // accumulating rows. attempts resets, TTL refreshes.
  await PendingSignup.findOneAndUpdate(
    { email: normalizedEmail },
    {
      email: normalizedEmail,
      password_hash,
      name: name || '',
      role,
      agency_id: agency_id || null,
      agency_name: agencyName || '',
      otp_hash,
      expires_at,
      attempts: 0,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const result = await emailService.sendSignupOtp({
    email: normalizedEmail,
    name: name || '',
    code: otp,
    ttlMinutes: Math.round(SIGNUP_OTP_TTL_MS / 60000),
  });
  logEmailOutcome('signup_otp', normalizedEmail, result);

  return { email: normalizedEmail, expires_in_seconds: Math.round(SIGNUP_OTP_TTL_MS / 1000) };
}

/**
 * Stage 2 of signup: verify the OTP and materialize the User/Agency.
 *
 * Error strategy:
 *   - Wrong code / expired code → 400. Increment `attempts`.
 *   - attempts >= MAX → 400 "try again later", force a fresh request-otp.
 *   - Anything goes wrong after the User.create → delete the half-written
 *     Agency so retries aren't blocked by a stale agency row.
 */
async function verifySignupOtp({ email, code }) {
  if (!email || !code) throw AppError.badRequest('email and code are required');
  const normalizedEmail = email.toLowerCase().trim();

  const pending = await PendingSignup.findOne({ email: normalizedEmail });
  if (!pending) {
    throw AppError.badRequest('No pending signup found — please request a new code.');
  }
  if (pending.expires_at <= new Date()) {
    await PendingSignup.deleteOne({ _id: pending._id });
    throw AppError.badRequest('Code expired — please request a new one.');
  }
  if (pending.attempts >= SIGNUP_OTP_MAX_ATTEMPTS) {
    throw AppError.badRequest('Too many incorrect attempts — please request a new code.');
  }

  const submittedHash = hashToken(String(code).trim());
  if (submittedHash !== pending.otp_hash) {
    pending.attempts += 1;
    await pending.save();
    const remaining = Math.max(0, SIGNUP_OTP_MAX_ATTEMPTS - pending.attempts);
    throw AppError.badRequest(
      remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`
        : 'Too many incorrect attempts — please request a new code.'
    );
  }

  // --- Code matches — materialize account ---------------------------------
  // Create agency inline only if one wasn't already chosen. `createdAgency`
  // is tracked so we can clean it up if the subsequent User insert fails.
  let finalAgencyId = pending.agency_id || null;
  let createdAgency = null;
  if (!finalAgencyId && pending.role === 'agency' && pending.agency_name) {
    createdAgency = await Agency.create({
      name: pending.agency_name,
      slug: slugify(pending.agency_name),
      contact_email: normalizedEmail,
    });
    finalAgencyId = createdAgency._id;
  }

  let user;
  try {
    // Create user first without password_hash
    user = new User({
      email: normalizedEmail,
      name: pending.name,
      role: pending.role,
      agency_id: finalAgencyId,
      email_verified: true, // the whole point — verification happened via OTP
    });
    
    // Set password directly from the hash stored in PendingSignup
    // Bypass setPassword() since we already have a valid bcrypt hash
    user.password_hash = pending.password_hash;
    
    // Save the user with the pre-hashed password
    await user.save();
  } catch (err) {
    // Uniqueness race: another verify request won, or the user created
    // an account by other means between request-otp and verify-otp. Roll
    // back the agency we just created so we don't orphan it.
    if (createdAgency) {
      await Agency.deleteOne({ _id: createdAgency._id }).catch(() => {});
    }
    if (err.code === 11000) {
      await PendingSignup.deleteOne({ _id: pending._id }).catch(() => {});
      throw AppError.conflict('An account with this email already exists.');
    }
    throw err;
  }

  // Single-use: always drop the pending record on success.
  await PendingSignup.deleteOne({ _id: pending._id }).catch(() => {});

  return { user, token: signToken(user) };
}

/**
 * Regenerate and re-send the OTP. Does NOT extend the original expiry
 * window — the new `expires_at` fully replaces it, which is strictly safer
 * than "sliding" a single long-lived code.
 */
async function resendSignupOtp({ email }) {
  if (!email) throw AppError.badRequest('email is required');
  const normalizedEmail = email.toLowerCase().trim();

  const pending = await PendingSignup.findOne({ email: normalizedEmail });
  if (!pending) {
    // Opaque: don't confirm/deny whether a pending signup exists. Success
    // shape matches the happy path so callers can't infer the answer.
    return { ok: true };
  }

  const otp = generateOtp();
  pending.otp_hash = hashToken(otp);
  pending.expires_at = new Date(Date.now() + SIGNUP_OTP_TTL_MS);
  pending.attempts = 0;
  await pending.save();

  const result = await emailService.sendSignupOtp({
    email: normalizedEmail,
    name: pending.name,
    code: otp,
    ttlMinutes: Math.round(SIGNUP_OTP_TTL_MS / 60000),
  });
  logEmailOutcome('signup_otp_resend', normalizedEmail, result);

  return { ok: true };
}

// --- Password reset (URL-based, unchanged) ----------------------------------
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

// --- Login ------------------------------------------------------------------
async function login({ email, password, agency_slug }) {
  if (!email || !password) {
    throw AppError.badRequest('email and password are required');
  }

  const normalizedEmail = email.toLowerCase().trim();

  let user;
  if (agency_slug) {
    // Slug-scoped portal (clients, agents). The lookup MUST stay bound to
    // that agency so an identical email at another agency can't be matched.
    const agency = await Agency.findOne({ slug: agency_slug.toLowerCase() });
    if (!agency) throw AppError.unauthorized('Invalid credentials');
    user = await User.findOne({ email: normalizedEmail, agency_id: agency._id })
      .select('+password_hash');
  } else {
    // No slug — dashboard login. Prefer platform admins (agency_id: null) so
    // admin auth behaves exactly as before; otherwise fall back to agency
    // owners / agents who authenticate on the same /login page without a
    // slug. 'client' is excluded: clients always use the per-agency portal.
    user = await User.findOne({ email: normalizedEmail, agency_id: null })
      .select('+password_hash');
    if (!user) {
      user = await User.findOne({
        email: normalizedEmail,
        role: { $in: ['agency', 'agent'] },
      }).select('+password_hash');
    }
  }

  if (!user || !user.is_active) throw AppError.unauthorized('Invalid credentials');

  const ok = await user.verifyPassword(password);
  if (!ok) throw AppError.unauthorized('Invalid credentials');

  user.last_login_at = new Date();
  await user.save();

  return { user, token: signToken(user) };
}

// --- Helpers ----------------------------------------------------------------
function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || `agency-${Date.now()}`;
}

// Uniform logging shape for every fire-and-forget transactional email so
// `kind` is always greppable in Railway logs.
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

module.exports = {
  signToken,
  verifyToken,
  requestSignupOtp,
  verifySignupOtp,
  resendSignupOtp,
  login,
  forgotPassword,
  resetPassword,
};
