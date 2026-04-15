/**
 * One-off migration: remove duplicate articles within the `articles`
 * collection.
 *
 * "Duplicate" = same title (case-insensitive, whitespace-trimmed).
 *
 * When multiple docs share a title, we keep exactly one, preferring:
 *   1. is_published: true  (over drafts)
 *   2. has a non-empty embedding (no need to re-index)
 *   3. most recent updated_at / created_at
 *   4. most recent _id as a final tiebreaker
 *
 * The rest are deleted. Run:
 *   railway run npm run dedupe-articles
 *
 * Idempotent. Safe to re-run.
 */
const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const logger = require('./logger');

async function run() {
  await connectDatabase();
  const db = mongoose.connection.db;

  const cols = await db.listCollections({ name: 'articles' }).toArray();
  if (cols.length === 0) {
    console.log('\nNo `articles` collection — nothing to dedupe.\n');
    await mongoose.connection.close();
    return;
  }

  // Pull embedding length too so we can prefer docs that already have one.
  // Don't pull the embedding itself — it's ~1536 floats per doc.
  const articles = await db
    .collection('articles')
    .find(
      {},
      {
        projection: {
          _id: 1,
          title: 1,
          is_published: 1,
          updated_at: 1,
          created_at: 1,
          embedding_len: { $size: { $ifNull: ['$embedding', []] } },
        },
      }
    )
    .toArray();

  console.log(`\nScanning ${articles.length} article(s) for duplicates…`);

  // Group by normalized title.
  const groups = new Map();
  for (const doc of articles) {
    const key = (doc.title || '').trim().toLowerCase();
    if (!key) continue; // skip untitled entries — don't want to collapse them all together
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(doc);
  }

  const toDelete = [];
  let duplicateGroups = 0;

  for (const [, docs] of groups) {
    if (docs.length < 2) continue;
    duplicateGroups += 1;

    docs.sort(compareKeepFirst);
    const [, ...losers] = docs;
    for (const l of losers) toDelete.push(l._id);
  }

  console.log(`  duplicate titles found: ${duplicateGroups}`);
  console.log(`  docs to delete:         ${toDelete.length}`);

  if (toDelete.length > 0) {
    const res = await db
      .collection('articles')
      .deleteMany({ _id: { $in: toDelete } });
    console.log(`  deleted:                ${res.deletedCount}`);
    logger.info('dedupe_articles_complete', {
      duplicate_groups: duplicateGroups,
      deleted: res.deletedCount,
    });
  } else {
    logger.info('dedupe_articles_noop');
  }

  await mongoose.connection.close();
  console.log('\nDone.\n');
}

/**
 * Sort comparator — "smaller" comes first, so the winner lands at index 0.
 * Criteria in priority order, each returns negative if `a` wins.
 */
function compareKeepFirst(a, b) {
  // Published beats draft.
  const pubA = a.is_published === true ? 1 : 0;
  const pubB = b.is_published === true ? 1 : 0;
  if (pubA !== pubB) return pubB - pubA;

  // Has embedding beats missing embedding.
  const embA = (a.embedding_len || 0) > 0 ? 1 : 0;
  const embB = (b.embedding_len || 0) > 0 ? 1 : 0;
  if (embA !== embB) return embB - embA;

  // Newer updated_at wins.
  const tA = timestampOf(a);
  const tB = timestampOf(b);
  if (tA !== tB) return tB - tA;

  // Final tiebreaker: later _id (ObjectIds are monotonic-ish by time).
  return b._id.toString().localeCompare(a._id.toString());
}

function timestampOf(doc) {
  const t = doc.updated_at || doc.created_at;
  if (!t) return 0;
  const d = t instanceof Date ? t : new Date(t);
  return d.getTime() || 0;
}

run().catch(async (err) => {
  logger.error('dedupe_articles_failed', { error: err.message, stack: err.stack });
  console.error('\n✗ Failed:', err.message, '\n');
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
