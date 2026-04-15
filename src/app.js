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
// Layered: every request hits the global API limiter first. Specific mount
// paths stack additional, tighter limits (auth brute-force, AI $$$).

// Identify the caller by authenticated user id when available, falling back
// to IP. Prevents NAT-shared offices from sharing one bucket across all
// their logged-in users, while still rate-limiting anonymous traffic.
const keyByUserOrIp = (req) =>
  req.user?._id?.toString() || req.ip;

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { error: { message: 'Too many requests, please slow down' } },
});
app.use('/api', apiLimiter);

// Tighter limit on auth endpoints to slow brute force. Keyed by IP only —
// failed logins have no req.user, so the per-user key would leak everything
// to a single IP bucket anyway.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many auth attempts' } },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/verify-email', authLimiter);
app.use('/api/auth/resend-verification', authLimiter);

// AI endpoints are expensive (OpenAI spend). The token-budget gate in
// ai.service.js catches cumulative overuse, but per-minute bursts can still
// waste a big slice of an agency's budget before the budget updates. Keep
// this tight and keyed per-user so one noisy teammate can't blow the quota
// for the whole agency.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { error: { message: 'AI rate limit exceeded — wait a moment and retry' } },
});
app.use('/api/ai', aiLimiter);

// Article management writes embeddings (OpenAI spend too). Looser than AI
// reply/summary because articles change rarely.
const articleWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  skip: (req) => req.method === 'GET',
  message: { error: { message: 'Article write rate limit exceeded' } },
});
app.use('/api/articles', articleWriteLimiter);

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
