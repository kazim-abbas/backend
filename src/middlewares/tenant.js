const { Agency } = require('../models');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Tenant isolation middleware.
 *
 * After `authenticate`, this resolves the effective agency for the request and
 * attaches it to `req.agency`. It also exposes `req.tenantFilter` — a Mongo
 * filter object every tenant-scoped query should spread into its `.find()`.
 *
 * Admins may optionally scope to a specific agency via `?agency_id=...` or the
 * `x-agency-id` header (for cross-tenant admin views).
 */
const resolveTenant = asyncHandler(async (req, res, next) => {
  if (!req.user) throw AppError.unauthorized();

  // Platform admins: either unscoped (req.agency = null) or scoped to a specific
  // agency via query/header. Never auto-leak data across tenants.
  if (req.user.role === 'admin') {
    const override = req.query.agency_id || req.headers['x-agency-id'];
    if (override) {
      const agency = await Agency.findById(override);
      if (!agency) throw AppError.notFound('Agency not found');
      req.agency = agency;
      req.tenantFilter = { agency_id: agency._id };
    } else {
      req.agency = null;
      req.tenantFilter = {}; // admin sees all
    }
    return next();
  }

  // Everyone else MUST have an agency_id on their user record.
  if (!req.user.agency_id) {
    throw AppError.forbidden('User is not associated with an agency');
  }

  const agency = await Agency.findById(req.user.agency_id);
  if (!agency || !agency.is_active) {
    throw AppError.forbidden('Agency is inactive');
  }

  req.agency = agency;
  req.tenantFilter = { agency_id: agency._id };
  next();
});

module.exports = { resolveTenant };
