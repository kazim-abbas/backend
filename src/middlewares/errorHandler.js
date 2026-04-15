const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const env = require('../config/env');

// 404 — no route matched
function notFound(req, res, next) {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// Centralized error responder
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let details = err.details;

  // Mongoose errors → 400
  if (err.name === 'ValidationError') {
    status = 400;
    details = err.errors;
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  } else if (err.code === 11000) {
    status = 409;
    message = 'Duplicate key';
    details = err.keyValue;
  }

  const logMeta = {
    status,
    path: req.originalUrl,
    method: req.method,
    user_id: req.user?._id?.toString(),
    agency_id: req.agency?._id?.toString(),
  };

  if (status >= 500) {
    logger.error(message, { ...logMeta, stack: err.stack });
  } else {
    logger.warn(message, logMeta);
  }

  res.status(status).json({
    error: {
      message,
      ...(details ? { details } : {}),
      ...(env.isProd ? {} : { stack: err.stack }),
    },
  });
}

module.exports = { notFound, errorHandler };
