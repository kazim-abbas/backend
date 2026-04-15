const app = require('./app');
const env = require('./config/env');
const { connectDatabase } = require('./config/database');
const logger = require('./utils/logger');

// Called at boot so operators see misconfiguration in the startup log
// rather than discovering it when a user doesn't receive their reset email.
function checkOptionalServices() {
  if (!env.resend.apiKey) {
    logger.warn('service_unconfigured', {
      service: 'resend',
      detail:
        'RESEND_API_KEY is not set — transactional emails (verification, password reset, alerts) will be skipped.',
    });
  } else if (
    !env.resend.fromEmail ||
    env.resend.fromEmail === 'notifications@example.com'
  ) {
    logger.warn('service_misconfigured', {
      service: 'resend',
      detail:
        'RESEND_FROM_EMAIL is empty or the placeholder default. Resend rejects sends from unverified domains — set it to an address on a verified Resend domain.',
      current: env.resend.fromEmail,
    });
  }

  if (!env.openai.apiKey) {
    logger.warn('service_unconfigured', {
      service: 'openai',
      detail: 'OPENAI_API_KEY is not set — AI reply/summary features will be disabled.',
    });
  }

  if (!env.intercom.apiKey) {
    logger.warn('service_unconfigured', {
      service: 'intercom',
      detail: 'INTERCOM_API_KEY is not set — outbound replies and webhook HMAC will not work.',
    });
  }
}

async function start() {
  await connectDatabase();

  checkOptionalServices();

  const server = app.listen(env.port, () => {
    logger.info('server_started', {
      port: env.port,
      env: env.nodeEnv,
    });
  });

  const shutdown = (signal) => {
    logger.info('shutdown_initiated', { signal });
    server.close(() => {
      logger.info('server_closed');
      process.exit(0);
    });
    // Hard exit if close hangs
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught_exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

start().catch((err) => {
  logger.error('server_failed_to_start', { error: err.message, stack: err.stack });
  process.exit(1);
});
