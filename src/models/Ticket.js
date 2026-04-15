const mongoose = require('mongoose');

const TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'];
const SENDER_TYPES = ['user', 'agent', 'ai', 'system'];

const MessageSchema = new mongoose.Schema(
  {
    sender: { type: String, enum: SENDER_TYPES, required: true },
    sender_id: { type: String, default: '' },
    sender_name: { type: String, default: '' },
    text: { type: String, required: true },
    intercom_part_id: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: true }
);

const TicketSchema = new mongoose.Schema(
  {
    intercom_conversation_id: {
      type: String,
      required: true,
      index: true,
    },

    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agency',
      required: true,
      index: true,
    },

    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    assigned_agent_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    subject: { type: String, default: '' },
    messages: { type: [MessageSchema], default: [] },

    status: {
      type: String,
      enum: TICKET_STATUSES,
      default: 'open',
      index: true,
    },

    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    tags: [{ type: String, trim: true }],

    ai_summary: { type: String, default: '' },
    ai_summary_updated_at: { type: Date },

    last_message_at: { type: Date, default: Date.now, index: true },
    resolved_at: { type: Date },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Tenant-scoped uniqueness: one intercom conversation per agency
TicketSchema.index(
  { agency_id: 1, intercom_conversation_id: 1 },
  { unique: true }
);

// Common list-query pattern: agency + status + recency
TicketSchema.index({ agency_id: 1, status: 1, last_message_at: -1 });

TicketSchema.statics.STATUSES = TICKET_STATUSES;
TicketSchema.statics.SENDER_TYPES = SENDER_TYPES;

module.exports = mongoose.model('Ticket', TicketSchema);
