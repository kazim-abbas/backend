const mongoose = require('mongoose');

/**
 * Transient storage for signup attempts awaiting OTP verification.
 *
 * Flow:
 *   1. User posts to /auth/signup/request-otp
 *   2. Backend hashes password, generates 6-digit OTP, stores both here
 *   3. OTP is emailed (raw code, never stored)
 *   4. User posts to /auth/signup/verify-otp with email + code
 *   5. On match → User / Agency are created from this record, record deleted
 *
 * Security notes:
 *   - Password is stored already-bcrypted; the plaintext never persists.
 *   - OTP is stored as a SHA-256 hash; DB leak cannot reveal active codes.
 *   - `attempts` caps brute-force at 5 tries per record (forces resend).
 *   - `expires_at` TTL index auto-deletes stale records after 15 min —
 *     no cron job needed.
 */
const PendingSignupSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // Already bcrypt-hashed in the service before saving — the plaintext
    // password never touches the database.
    password_hash: { type: String, required: true },

    name: { type: String, trim: true, default: '' },
    role: {
      type: String,
      enum: ['admin', 'agency', 'agent'],
      default: 'agency',
    },

    // If they're joining an existing agency we record the id; otherwise
    // we hold the name and create the agency at verify time.
    agency_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', default: null },
    agency_name: { type: String, trim: true, default: '' },

    otp_hash: { type: String, required: true },
    expires_at: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// TTL: Mongo drops the document once `expires_at` is in the past. The field
// is set to now + OTP_TTL so stale records clean themselves up even if the
// user abandons the flow mid-way.
PendingSignupSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PendingSignup', PendingSignupSchema);
