const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const auth = {
  register: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
    name: z.string().max(200).optional(),
    role: z.enum(['admin', 'agency', 'agent']).optional().default('agency'),
    agency_id: objectId.optional(),
    agencyName: z.string().min(2).max(200).optional(),
  }),
  login: z.object({
    email: z.string().email(),
    password: z.string().min(1),
    agency_slug: z.string().optional(),
  }),
  forgotPassword: z.object({
    email: z.string().email(),
    agency_slug: z.string().optional(),
  }),
  resetPassword: z.object({
    token: z.string().min(20).max(200),
    password: z.string().min(8).max(200),
  }),
  verifyEmail: z.object({
    token: z.string().min(20).max(200),
  }),
  resendVerification: z.object({
    email: z.string().email(),
    agency_slug: z.string().optional(),
  }),
};

const tickets = {
  list: z.object({
    status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(),
    search: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    agency_id: objectId.optional(),
  }),
  getById: z.object({ id: objectId }),
  updateStatus: z.object({
    status: z.enum(['open', 'pending', 'resolved', 'closed']),
  }),
  reply: z.object({
    text: z.string().min(1).max(10000),
  }),
};

const ai = {
  reply: z.object({
    ticket_id: objectId,
  }),
  summary: z.object({
    ticket_id: objectId,
  }),
};

const admin = {
  settings: z.object({
    ai_enabled_global: z.boolean().optional(),
    features: z
      .object({
        summary: z.boolean().optional(),
        auto_reply: z.boolean().optional(),
      })
      .optional(),
    default_token_limit: z.number().int().min(0).optional(),
    token_warning_threshold: z.number().min(0).max(1).optional(),
  }),
};

const agency = {
  update: z.object({
    name: z.string().min(2).max(200).optional(),
    ai_enabled: z.boolean().optional(),
    token_limit: z.number().int().min(0).optional(),
    plan: z.enum(['starter', 'growth', 'pro', 'custom']).optional(),
    features: z
      .object({
        summary: z.boolean().optional(),
        auto_reply: z.boolean().optional(),
        white_label: z.boolean().optional(),
      })
      .optional(),
    is_active: z.boolean().optional(),
    contact_email: z.string().email().optional(),
  }),
  create: z.object({
    name: z.string().min(2).max(200),
    plan: z.enum(['starter', 'growth', 'pro', 'custom']).optional(),
    token_limit: z.number().int().min(0).optional(),
    contact_email: z.string().email().optional(),
    intercom_app_id: z.string().optional(),
  }),
};

const article = {
  create: z.object({
    title: z.string().min(1).max(500),
    content: z.string().min(1),
    tags: z.array(z.string()).optional(),
    is_published: z.boolean().optional(),
  }),
  update: z.object({
    title: z.string().min(1).max(500).optional(),
    content: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    is_published: z.boolean().optional(),
  }),
};

module.exports = { auth, tickets, ai, admin, agency, article, objectId };
