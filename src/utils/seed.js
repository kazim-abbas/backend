/**
 * Seed script — run with `npm run seed`.
 *
 * Creates:
 *   - AdminSettings singleton
 *   - A platform admin user
 *   - A demo agency with an owner user
 *   - A sample help article (no embedding unless OPENAI_API_KEY is set)
 *
 * Idempotent: safe to re-run; it upserts by key fields.
 */
const env = require('../config/env');
const { connectDatabase } = require('../config/database');
const mongoose = require('mongoose');
const { Agency, User, AdminSettings, HelpArticle } = require('../models');
const logger = require('./logger');

async function run() {
  await connectDatabase();

  const settings = await AdminSettings.getSingleton();
  logger.info('seed_admin_settings_ready', { id: settings._id.toString() });

  const adminEmail = 'admin@example.com';
  let admin = await User.findOne({ email: adminEmail, agency_id: null });
  if (!admin) {
    admin = new User({ email: adminEmail, name: 'Platform Admin', role: 'admin', agency_id: null });
    await admin.setPassword('ChangeMe123!');
    await admin.save();
    logger.info('seed_admin_created', { email: adminEmail, password: 'ChangeMe123!' });
  }

  let agency = await Agency.findOne({ slug: 'demo-agency' });
  if (!agency) {
    agency = await Agency.create({
      name: 'Demo Agency',
      slug: 'demo-agency',
      plan: 'growth',
      token_limit: 20000,
      contact_email: 'owner@demo-agency.com',
    });
    logger.info('seed_agency_created', { slug: agency.slug });
  }

  const ownerEmail = 'owner@demo-agency.com';
  let owner = await User.findOne({ email: ownerEmail, agency_id: agency._id });
  if (!owner) {
    owner = new User({
      email: ownerEmail,
      name: 'Agency Owner',
      role: 'agency',
      agency_id: agency._id,
    });
    await owner.setPassword('ChangeMe123!');
    await owner.save();
    logger.info('seed_owner_created', { email: ownerEmail, password: 'ChangeMe123!' });
  }

  const existingArticle = await HelpArticle.findOne({
    agency_id: agency._id,
    title: 'Reset your password',
  });
  if (!existingArticle) {
    await HelpArticle.create({
      agency_id: agency._id,
      title: 'Reset your password',
      content:
        'To reset your password, click "Forgot password" on the login screen, ' +
        'enter your email, and follow the link we send you. The link expires in 1 hour.',
      tags: ['password', 'auth'],
    });
    logger.info('seed_article_created');
  }

  await mongoose.connection.close();
  logger.info('seed_complete');
}

run().catch((err) => {
  logger.error('seed_failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
