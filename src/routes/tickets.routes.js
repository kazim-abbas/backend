const express = require('express');
const ctrl = require('../controllers/tickets.controller');
const validate = require('../middlewares/validate');
const { authenticate, requireRole } = require('../middlewares/auth');
const { resolveTenant } = require('../middlewares/tenant');
const v = require('../validators');

const router = express.Router();

// All ticket routes are authenticated and tenant-scoped.
router.use(authenticate, resolveTenant);

router.get('/', validate({ query: v.tickets.list }), ctrl.list);
router.get('/:id', validate({ params: v.tickets.getById }), ctrl.getById);

router.patch(
  '/:id/status',
  requireRole('admin', 'agency', 'agent'),
  validate({ params: v.tickets.getById, body: v.tickets.updateStatus }),
  ctrl.updateStatus
);

router.post(
  '/:id/reply',
  requireRole('admin', 'agency', 'agent'),
  validate({ params: v.tickets.getById, body: v.tickets.reply }),
  ctrl.reply
);

module.exports = router;
