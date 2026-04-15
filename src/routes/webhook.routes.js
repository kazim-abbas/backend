const express = require('express');
const ctrl = require('../controllers/webhook.controller');

const router = express.Router();

/**
 * IMPORTANT: raw body required for HMAC signature verification.
 * Do NOT mount express.json() before this — it must see the raw bytes.
 */
router.post(
  '/intercom',
  express.raw({ type: 'application/json', limit: '2mb' }),
  ctrl.handleIntercom
);

module.exports = router;
