const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User, Agency } = require('../models');
const AppError = require('../utils/AppError');

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
  await user.save();

  return { user, token: signToken(user) };
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

module.exports = { signToken, verifyToken, register, login };
