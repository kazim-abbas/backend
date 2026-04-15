const asyncHandler = require('../utils/asyncHandler');
const authService = require('../services/auth.service');

/**
 * Stage 1 of signup: stash credentials + send OTP. Does NOT create a User
 * yet — that happens in verifyOtp once the code is confirmed. Returns 202
 * (Accepted) because the work is "pending verification", not "created".
 */
const register = asyncHandler(async (req, res) => {
  const result = await authService.requestSignupOtp(req.body);
  res.status(202).json({
    ok: true,
    email: result.email,
    expires_in_seconds: result.expires_in_seconds,
    message: 'A verification code has been sent to your email.',
  });
});

/**
 * Stage 2 of signup: consume the OTP and materialize the User / Agency.
 * On success we return the new JWT so the client can sign in immediately
 * without a second round-trip to /login.
 */
const verifyOtp = asyncHandler(async (req, res) => {
  const { user, token } = await authService.verifySignupOtp(req.body);
  res.status(201).json({ user: user.toPublicJSON(), token });
});

/**
 * Regenerate the OTP for an existing pending signup. Response shape is
 * deliberately opaque — it doesn't reveal whether a pending signup
 * actually existed, so this endpoint can't be used for email enumeration.
 */
const resendOtp = asyncHandler(async (req, res) => {
  await authService.resendSignupOtp(req.body);
  res.json({
    ok: true,
    message: 'If a pending signup exists for that email, a new code has been sent.',
  });
});

const login = asyncHandler(async (req, res) => {
  const { user, token } = await authService.login(req.body);
  res.json({ user: user.toPublicJSON(), token });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user.toPublicJSON() });
});

const forgotPassword = asyncHandler(async (req, res) => {
  await authService.forgotPassword(req.body);
  // Always opaque: don't reveal whether the email existed.
  res.json({
    ok: true,
    message: 'If an account exists for that email, a reset link has been sent.',
  });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { user, token } = await authService.resetPassword(req.body);
  res.json({ user: user.toPublicJSON(), token });
});

module.exports = {
  register,
  verifyOtp,
  resendOtp,
  login,
  me,
  forgotPassword,
  resetPassword,
};
