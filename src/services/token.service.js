const { Agency, TokenUsage } = require('../models');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

/**
 * Enforce AI gating: global kill-switch, agency kill-switch, feature toggle,
 * and remaining token budget. Throws AppError on denial.
 *
 * Centralized here (not scattered through controllers) so every AI call goes
 * through the same check.
 */
async function assertAIAllowed({ agency, adminSettings, feature }) {
  if (!adminSettings.ai_enabled_global) {
    throw AppError.forbidden('AI features are globally disabled');
  }
  if (adminSettings.features && adminSettings.features[feature] === false) {
    throw AppError.forbidden(`AI feature "${feature}" is globally disabled`);
  }
  if (!agency) {
    throw AppError.badRequest('Agency context is required for AI operations');
  }
  if (!agency.canUseAI()) {
    throw AppError.forbidden('AI is disabled for this agency');
  }
  if (agency.features && agency.features[feature] === false) {
    throw AppError.forbidden(`AI feature "${feature}" is disabled for this agency`);
  }
  if (agency.tokens_used >= agency.token_limit) {
    throw AppError.paymentRequired('Token limit reached for this billing period');
  }
}

/**
 * Record actual usage after an AI call. Uses an atomic $inc so concurrent
 * requests do not clobber each other.
 */
async function recordUsage({ agency, ticketId = null, feature, model, usage }) {
  const prompt_tokens = usage?.prompt_tokens || 0;
  const completion_tokens = usage?.completion_tokens || 0;
  const total_tokens = usage?.total_tokens || prompt_tokens + completion_tokens;

  await TokenUsage.create({
    agency_id: agency._id,
    ticket_id: ticketId,
    feature,
    model,
    prompt_tokens,
    completion_tokens,
    total_tokens,
  });

  const updated = await Agency.findByIdAndUpdate(
    agency._id,
    { $inc: { tokens_used: total_tokens } },
    { new: true }
  );

  logger.info('ai_tokens_recorded', {
    agency_id: agency._id.toString(),
    feature,
    total_tokens,
    tokens_used: updated?.tokens_used,
    token_limit: updated?.token_limit,
  });

  return updated;
}

/**
 * Aggregate usage over a time window — used by the admin/agency dashboards.
 */
async function getUsageSummary({ agency_id, since }) {
  const match = {};
  if (agency_id) match.agency_id = agency_id;
  if (since) match.created_at = { $gte: since };

  const [byFeature, total] = await Promise.all([
    TokenUsage.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$feature',
          total_tokens: { $sum: '$total_tokens' },
          calls: { $sum: 1 },
        },
      },
    ]),
    TokenUsage.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total_tokens: { $sum: '$total_tokens' },
          calls: { $sum: 1 },
        },
      },
    ]),
  ]);

  return {
    total: total[0] || { total_tokens: 0, calls: 0 },
    by_feature: byFeature,
  };
}

module.exports = { assertAIAllowed, recordUsage, getUsageSummary };
