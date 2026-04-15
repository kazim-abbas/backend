const express = require('express');
const ctrl = require('../controllers/auth.controller');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');
const v = require('../validators');

const router = express.Router();

router.post('/register', validate({ body: v.auth.register }), ctrl.register);
router.post('/login', validate({ body: v.auth.login }), ctrl.login);
router.get('/me', authenticate, ctrl.me);

router.post(
  '/forgot-password',
  validate({ body: v.auth.forgotPassword }),
  ctrl.forgotPassword
);
router.post(
  '/reset-password',
  validate({ body: v.auth.resetPassword }),
  ctrl.resetPassword
);
router.post(
  '/verify-email',
  validate({ body: v.auth.verifyEmail }),
  ctrl.verifyEmail
);
router.post(
  '/resend-verification',
  validate({ body: v.auth.resendVerification }),
  ctrl.resendVerification
);

module.exports = router;
