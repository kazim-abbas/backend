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

    // Email verification: users created via the password-based signup start
    // unverified. Clients ingested from Intercom are implicitly trusted since
    // Intercom already owns the identity, so we default them to verified.
    email_verified: { type: Boolean, default: false },
    email_verification_token_hash: { type: String, default: '', select: false },
    email_verification_expires: { type: Date, default: null, select: false },

    // Password reset: hashed token with a short TTL. The hash (not the raw
    // token) is stored so a DB leak alone can't reset anyone's password.
    password_reset_token_hash: { type: String, default: '', select: false },
    password_reset_expires: { type: Date, default: null, select: false },

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
    email_verified: this.email_verified,
    created_at: this.created_at,
  };
};

UserSchema.statics.ROLES = ROLES;

module.exports = mongoose.model('User', UserSchema);
