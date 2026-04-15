const asyncHandler = require('../utils/asyncHandler');
const authService = require('../services/auth.service');

const register = asyncHandler(async (req, res) => {
  const { user, token } = await authService.register(req.body);
  res.status(201).json({ user: user.toPublicJSON(), token });
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

const verifyEmail = asyncHandler(async (req, res) => {
  const { user } = await authService.verifyEmail(req.body);
  res.json({ user: user.toPublicJSON() });
});

const resendVerification = asyncHandler(async (req, res) => {
  await authService.resendVerification(req.body);
  res.json({
    ok: true,
    message: 'If the account exists and is unverified, a new link has been sent.',
  });
});

module.exports = {
  register,
  login,
  me,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
};
