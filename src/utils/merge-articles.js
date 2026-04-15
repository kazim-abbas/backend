/**
 * One-off migration: merge the legacy `helparticles` collection into the
 * canonical `articles` collection, then drop `helparticles`.
 *
 * Why this exists:
 *   Before the `HelpArticle` model was pinned to `collection: 'articles'`,
 *   Mongoose auto-pluralized the model name and wrote to `helparticles`.
 *   Meanwhile an `articles` collection already existed in the DB (seeded
 *   directly in Atlas). That split meant articles created by admins could
 *   land in one collection while agencies read the other.
 *
 * What it does:
 *   1. Reads all docs from `helparticles`.
 *   2. For each, skips if an `articles` doc already exists with the same
 *      `_id` OR the same `title` (case-insensitive, trimmed).
 *   3. Otherwise inserts it into `articles`.
 *   4. Drops `helparticles` when done (only if the copy phase succeeded).
 *
 * Idempotent: running it twice is a no-op once `helparticles` is gone.
 *
 * Run locally:
 *   MONGODB_URI=... npm run merge-articles
 *
 * Run on Railway:
 *   railway run npm run merge-articles
 */
const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const logger = require('./logger');

async function run() {
  await connectDatabase();
  const db = mongoose.connection.db;

  // Ensure both collections actually exist before touching them — Mongo will
  // happily throw NamespaceNotFound on an unknown collection otherwise.
  const cols = await db.listCollections().toArray();
  const names = new Set(cols.map((c) => c.name));

  if (!names.has('helparticles')) {
    console.log('\nNothing to merge — `helparticles` collection does not exist.\n');
    await mongoose.connection.close();
    return;
  }
  if (!names.has('articles')) {
    // Create the empty target so inserts have somewhere to go.
    await db.createCollection('articles');
    logger.info('merge_articles_created_target');
  }

  const legacy = db.collection('helparticles');
  const target = db.collection('articles');

  const legacyDocs = await legacy.find({}).toArray();
  console.log(`\nFound ${legacyDocs.length} doc(s) in helparticles.`);

  let copied = 0;
  let skippedById = 0;
  let skippedByTitle = 0;

  for (const doc of legacyDocs) {
    // Duplicate by _id — this would only happen if someone manually copied
    // rows between collections before running the migration.
    const sameId = await target.findOne({ _id: doc._id });
    if (sameId) {
      skippedById += 1;
      continue;
    }

    // Duplicate by title — articles are identified to users by their title,
    // so treat a case-insensitive title match as "already present."
    const title = (doc.title || '').trim();
    if (title) {
      const sameTitle = await target.findOne({
        title: { $regex: `^${escapeRegex(title)}$`, $options: 'i' },
      });
      if (sameTitle) {
        skippedByTitle += 1;
        continue;
      }
    }

    await target.insertOne(doc);
    copied += 1;
  }

  console.log(`  copied:           ${copied}`);
  console.log(`  skipped (by _id): ${skippedById}`);
  console.log(`  skipped (title):  ${skippedByTitle}`);

  // Drop the legacy collection only after a successful copy phase.
  await legacy.drop();
  console.log('\nDropped legacy `helparticles` collection.');

  logger.info('merge_articles_complete', {
    copied,
    skipped_by_id: skippedById,
    skipped_by_title: skippedByTitle,
  });

  await mongoose.connection.close();
  console.log('\nDone.\n');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

run().catch(async (err) => {
  logger.error('merge_articles_failed', { error: err.message, stack: err.stack });
  console.error('\n✗ Failed:', err.message, '\n');
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
