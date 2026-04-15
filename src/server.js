const app = require('./app');
const env = require('./config/env');
const { connectDatabase } = require('./config/database');
const logger = require('./utils/logger');

async function start() {
  await connectDatabase();

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
