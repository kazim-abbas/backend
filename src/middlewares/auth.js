const { verifyToken } = require('../services/auth.service');
const { User } = require('../models');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Extract Bearer token, verify it, attach `req.user`.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw AppError.unauthorized('Missing Bearer token');
  }

  const payload = verifyToken(token);
  const user = await User.findById(payload.sub);
  if (!user || !user.is_active) {
    throw AppError.unauthorized('User not found or inactive');
  }

  req.user = user;
  req.auth = payload;
  next();
});

/**
 * Role guard. Pass allowed roles as arguments.
 *   router.get('/admin', authenticate, requireRole('admin'), handler)
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(AppError.unauthorized());
  if (!roles.includes(req.user.role)) {
    return next(AppError.forbidden(`Requires role: ${roles.join(', ')}`));
  }
  next();
};

module.exports = { authenticate, requireRole };
