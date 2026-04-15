const AppError = require('../utils/AppError');

/**
 * Zod validation middleware.
 *   validate({ body: schema, query: schema, params: schema })
 * Replaces req.body/query/params with the parsed (typed + coerced) values.
 */
module.exports = function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      if (err.name === 'ZodError') {
        return next(AppError.badRequest('Validation failed', err.issues));
      }
      next(err);
    }
  };
};
