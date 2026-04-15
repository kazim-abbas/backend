const express = require('express');
const ctrl = require('../controllers/articles.controller');
const validate = require('../middlewares/validate');
const { authenticate, requireRole } = require('../middlewares/auth');
const { resolveTenant } = require('../middlewares/tenant');
const v = require('../validators');

const router = express.Router();

router.use(authenticate, resolveTenant);

router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.post(
  '/',
  requireRole('admin', 'agency'),
  validate({ body: v.article.create }),
  ctrl.create
);
router.patch(
  '/:id',
  requireRole('admin', 'agency'),
  validate({ body: v.article.update }),
  ctrl.update
);
router.delete('/:id', requireRole('admin', 'agency'), ctrl.remove);

module.exports = router;
