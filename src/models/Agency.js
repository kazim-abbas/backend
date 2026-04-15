const mongoose = require('mongoose');

const PLANS = ['starter', 'growth', 'pro', 'custom'];

const AgencySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },

    plan: { type: String, enum: PLANS, default: 'starter', index: true },
    ai_enabled: { type: Boolean, default: true },

    token_limit: { type: Number, default: 5000, min: 0 },
    tokens_used: { type: Number, default: 0, min: 0 },

    billing_period_start: { type: Date, default: Date.now },
    billing_period_end: { type: Date },

    intercom_app_id: { type: String, default: '' },
    intercom_workspace_id: { type: String, default: '', index: true },

    features: {
      summary: { type: Boolean, default: true },
      auto_reply: { type: Boolean, default: true },
      white_label: { type: Boolean, default: false },
    },

    contact_email: { type: String, trim: true, lowercase: true },

    is_active: { type: Boolean, default: true, index: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

AgencySchema.methods.hasTokensRemaining = function (requested = 0) {
  return this.tokens_used + requested <= this.token_limit;
};

AgencySchema.methods.canUseAI = function () {
  return this.is_active && this.ai_enabled;
};

AgencySchema.statics.PLANS = PLANS;

module.exports = mongoose.model('Agency', AgencySchema);
