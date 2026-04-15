const mongoose = require('mongoose');

const HelpArticleSchema = new mongoose.Schema(
  {
    // Historical field. Articles are now a single shared pool used by every
    // agency, so new rows are written without an agency_id. Kept optional
    // for backward compatibility with existing per-agency rows in the DB.
    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agency',
      default: null,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    content: { type: String, required: true },

    // Precomputed embedding vector (e.g. 1536 dims for text-embedding-3-small).
    // Stored as plain array; for scale consider Atlas Vector Search or a dedicated
    // vector DB. This schema keeps queries simple while remaining portable.
    embedding: { type: [Number], default: [], select: false },

    tags: [{ type: String, trim: true }],
    is_published: { type: Boolean, default: true },
  },
  {
    // Pin the collection name. Without this, Mongoose auto-pluralizes
    // "HelpArticle" → "helparticles", which split data across two collections
    // (the legacy `articles` collection already existed in the DB). Everything
    // now reads and writes to a single `articles` collection.
    collection: 'articles',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

HelpArticleSchema.index({ agency_id: 1, is_published: 1 });
HelpArticleSchema.index({ title: 'text', content: 'text' });

module.exports = mongoose.model('HelpArticle', HelpArticleSchema);
