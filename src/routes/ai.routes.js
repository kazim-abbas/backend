const express = require('express');
const ctrl = require('../controllers/ai.controller');
const validate = require('../middlewares/validate');
const { authenticate, requireRole } = require('../middlewares/auth');
const { resolveTenant } = require('../middlewares/tenant');
const v = require('../validators');

const router = express.Router();

router.use(authenticate, resolveTenant, requireRole('admin', 'agency', 'agent'));

router.post('/reply', validate({ body: v.ai.reply }), ctrl.reply);
router.post('/summary', validate({ body: v.ai.summary }), ctrl.summary);

module.exports = router;
