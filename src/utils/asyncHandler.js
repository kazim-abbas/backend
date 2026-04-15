/**
 * Wraps async express handlers so thrown errors reach the error middleware
 * without try/catch in every controller.
 */
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
