const mongoose = require('mongoose');

const FEATURES = ['auto_reply', 'summary', 'embedding', 'other'];

const TokenUsageSchema = new mongoose.Schema(
  {
    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agency',
      required: true,
      index: true,
    },
    ticket_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ticket',
      default: null,
      index: true,
    },
    feature: { type: String, enum: FEATURES, required: true, index: true },
    model: { type: String, default: '' },

    prompt_tokens: { type: Number, default: 0, min: 0 },
    completion_tokens: { type: Number, default: 0, min: 0 },
    total_tokens: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

// Aggregation patterns: usage per agency over a time window
TokenUsageSchema.index({ agency_id: 1, created_at: -1 });
TokenUsageSchema.index({ agency_id: 1, feature: 1, created_at: -1 });

TokenUsageSchema.statics.FEATURES = FEATURES;

module.exports = mongoose.model('TokenUsage', TokenUsageSchema);
