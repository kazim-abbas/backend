require('dotenv').config();

const required = (key, fallback) => {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return value;
};

const optional = (key, fallback = '') => process.env[key] ?? fallback;

const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '4000'), 10),
  corsOrigin: optional('CORS_ORIGIN', 'http://localhost:3000'),

  // Public URL of the frontend — used to build password-reset and
  // email-verification links sent to users. Falls back to CORS_ORIGIN since
  // both normally point at the same place.
  frontendUrl: optional('FRONTEND_URL', optional('CORS_ORIGIN', 'http://localhost:3000')),

  mongodbUri: required('MONGODB_URI'),

  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '7d'),

  intercom: {
    apiKey: optional('INTERCOM_API_KEY'),
    adminId: optional('INTERCOM_ADMIN_ID'),
    clientSecret: optional('INTERCOM_CLIENT_SECRET'),
  },

  openai: {
    apiKey: optional('OPENAI_API_KEY'),
    model: optional('OPENAI_MODEL', 'gpt-4o-mini'),
    embeddingModel: optional('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
  },

  resend: {
    apiKey: optional('RESEND_API_KEY'),
    fromEmail: optional('RESEND_FROM_EMAIL', 'notifications@example.com'),
  },
};

env.isProd = env.nodeEnv === 'production';

module.exports = env;
