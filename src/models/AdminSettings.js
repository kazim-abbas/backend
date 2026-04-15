const mongoose = require('mongoose');

// Singleton document. Use `AdminSettings.getSingleton()` to load or create it.
const AdminSettingsSchema = new mongoose.Schema(
  {
    singleton_key: { type: String, default: 'global', unique: true },

    ai_enabled_global: { type: Boolean, default: true },

    features: {
      summary: { type: Boolean, default: true },
      auto_reply: { type: Boolean, default: true },
    },

    default_token_limit: { type: Number, default: 5000 },
    token_warning_threshold: { type: Number, default: 0.8 }, // warn at 80%
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

AdminSettingsSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ singleton_key: 'global' });
  if (!doc) {
    doc = await this.create({ singleton_key: 'global' });
  }
  return doc;
};

module.exports = mongoose.model('AdminSettings', AdminSettingsSchema);
