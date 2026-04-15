const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { Agency } = require('../models');
const tokenService = require('../services/token.service');

/**
 * Return the agency record for the authenticated user's tenant.
 */
const me = asyncHandler(async (req, res) => {
  if (!req.agency) throw AppError.notFound('No agency in context');
  res.json({ agency: req.agency });
});

/**
 * Agency-scoped update. Only agency role (owner) can modify their own agency.
 * Some fields (plan, token_limit) are typically admin-only — the router
 * enforces that via requireRole before getting here.
 */
const updateMe = asyncHandler(async (req, res) => {
  if (!req.agency) throw AppError.notFound('No agency in context');

  // Non-admins cannot change billing-sensitive fields from this endpoint.
  const body = { ...req.body };
  if (req.user.role !== 'admin') {
    delete body.plan;
    delete body.token_limit;
    delete body.is_active;
  }

  Object.assign(req.agency, body);
  if (req.body.features) {
    req.agency.features = { ...req.agency.features, ...req.body.features };
  }
  await req.agency.save();
  res.json({ agency: req.agency });
});

const usage = asyncHandler(async (req, res) => {
  if (!req.agency) throw AppError.notFound('No agency in context');
  const since = req.query.since ? new Date(req.query.since) : null;
  const summary = await tokenService.getUsageSummary({
    agency_id: req.agency._id,
    since,
  });
  res.json({
    ...summary,
    tokens_used: req.agency.tokens_used,
    token_limit: req.agency.token_limit,
    percent_used: req.agency.token_limit
      ? req.agency.tokens_used / req.agency.token_limit
      : 0,
  });
});

module.exports = { me, updateMe, usage };
