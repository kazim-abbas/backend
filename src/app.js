const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const apiRouter = require('./routes');
const webhookRouter = require('./routes/webhook.routes');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

const app = express();

// --- Security & infra middleware --------------------------------------------

app.set('trust proxy', 1); // trust Railway/ingress proxy for correct IPs
app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(',').map((s) => s.trim()),
    credentials: true,
  })
);
app.use(compression());

if (!env.isProd) {
  app.use(morgan('dev'));
}

// --- Webhooks MUST come before express.json() -------------------------------
// Intercom's HMAC verification requires the raw body. Any route that needs
// raw bytes must be mounted before the JSON parser.
app.use('/webhooks', webhookRouter);

// --- JSON body parser for the rest ------------------------------------------
app.use(express.json({ limit: '1mb' }));

// --- Rate limiting ----------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests, please slow down' } },
});
app.use('/api', apiLimiter);

// Tighter limit on auth endpoints to slow brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many auth attempts' } },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// --- Routes -----------------------------------------------------------------
app.use('/api', apiRouter);

// Root / sanity check
app.get('/', (req, res) => {
  res.json({ name: 'support-saas-backend', status: 'ok' });
});

// --- Error handling ---------------------------------------------------------
app.use(notFound);
app.use(errorHandler);

module.exports = app;
