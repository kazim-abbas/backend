const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ROLES = ['admin', 'agency', 'agent', 'client'];

const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password_hash: { type: String, required: true, select: false },
    name: { type: String, trim: true, default: '' },

    role: { type: String, enum: ROLES, required: true, index: true },

    // null for platform admin; set for agency/agent/client
    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agency',
      default: null,
      index: true,
    },

    intercom_user_id: { type: String, default: '', index: true },

    is_active: { type: Boolean, default: true },
    last_login_at: { type: Date },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Email is unique per agency (so the same email can be a client at two agencies)
// Admins have agency_id = null and must have globally unique emails.
UserSchema.index({ email: 1, agency_id: 1 }, { unique: true });

UserSchema.methods.setPassword = async function (plain) {
  const salt = await bcrypt.genSalt(12);
  this.password_hash = await bcrypt.hash(plain, salt);
};

UserSchema.methods.verifyPassword = async function (plain) {
  if (!this.password_hash) return false;
  return bcrypt.compare(plain, this.password_hash);
};

UserSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    email: this.email,
    name: this.name,
    role: this.role,
    agency_id: this.agency_id ? this.agency_id.toString() : null,
    is_active: this.is_active,
    created_at: this.created_at,
  };
};

UserSchema.statics.ROLES = ROLES;

module.exports = mongoose.model('User', UserSchema);
