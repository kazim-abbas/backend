/**
 * One-off script: create or reset the platform admin.
 *
 * Unlike `seed.js`, this script only touches the admin User — it won't
 * create demo agencies or sample articles. Safe to run against production.
 *
 *   # Local (one-time), with MONGODB_URI exported to your shell:
 *   npm run set-admin
 *
 *   # On Railway:
 *   railway run npm run set-admin
 *
 * Env overrides (optional — defaults target support@ghle.net):
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=SuperSecret123 npm run set-admin
 */
const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const { User } = require('../models');
const logger = require('./logger');

const DEFAULT_EMAIL = 'support@ghle.net';
const DEFAULT_PASSWORD = 'Kazim@110';

async function run() {
  const email = (process.env.ADMIN_EMAIL || DEFAULT_EMAIL).toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD;

  if (!password || password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters');
  }

  await connectDatabase();

  // Platform admins are unambiguously identified by (email, agency_id=null).
  let admin = await User.findOne({ email, agency_id: null }).select('+password_hash');

  if (!admin) {
    admin = new User({
      email,
      name: 'Platform Admin',
      role: 'admin',
      agency_id: null,
      email_verified: true,
      is_active: true,
    });
    await admin.setPassword(password);
    await admin.save();
    logger.info('set_admin_created', { email });
  } else {
    // Reset password + make sure role/active/verified are in a good state,
    // but leave name and other metadata alone.
    await admin.setPassword(password);
    admin.role = 'admin';
    admin.agency_id = null;
    admin.is_active = true;
    admin.email_verified = true;
    // Clear any stale reset/verify tokens from previous sessions.
    admin.password_reset_token_hash = '';
    admin.password_reset_expires = null;
    admin.email_verification_token_hash = '';
    admin.email_verification_expires = null;
    await admin.save();
    logger.info('set_admin_updated', { email });
  }

  await mongoose.connection.close();

  // Human-readable confirmation (the logger output is structured).
  console.log('\n✓ Platform admin is ready:');
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log('  role:     admin (no agency)\n');
}

run().catch((err) => {
  logger.error('set_admin_failed', { error: err.message, stack: err.stack });
  console.error('\n✗ Failed:', err.message, '\n');
  process.exit(1);
});
