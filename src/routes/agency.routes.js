const express = require('express');
const ctrl = require('../controllers/agency.controller');
const validate = require('../middlewares/validate');
const { authenticate, requireRole } = require('../middlewares/auth');
const { resolveTenant } = require('../middlewares/tenant');
const v = require('../validators');

const router = express.Router();

router.use(authenticate, resolveTenant);

router.get('/me', ctrl.me);
router.patch(
  '/me',
  requireRole('admin', 'agency'),
  validate({ body: v.agency.update }),
  ctrl.updateMe
);
router.get('/me/usage', ctrl.usage);

module.exports = router;
