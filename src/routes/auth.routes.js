const express = require('express');
const ctrl = require('../controllers/auth.controller');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');
const v = require('../validators');

const router = express.Router();

// --- Signup OTP flow --------------------------------------------------------
// /register stashes the payload + emails the OTP. No User is created here.
// /verify-otp consumes the code and materializes the User (+ Agency).
// /resend-otp regenerates a fresh code against the existing pending record.
router.post('/register', validate({ body: v.auth.register }), ctrl.register);
router.post('/verify-otp', validate({ body: v.auth.verifyOtp }), ctrl.verifyOtp);
router.post('/resend-otp', validate({ body: v.auth.resendOtp }), ctrl.resendOtp);

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

module.exports = router;
