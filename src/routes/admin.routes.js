const express = require('express');
const ctrl = require('../controllers/admin.controller');
const validate = require('../middlewares/validate');
const { authenticate, requireRole } = require('../middlewares/auth');
const v = require('../validators');

const router = express.Router();

// Platform-admin only.
router.use(authenticate, requireRole('admin'));

router.get('/settings', ctrl.getSettings);
router.patch('/settings', validate({ body: v.admin.settings }), ctrl.updateSettings);

router.get('/agencies', ctrl.listAgencies);
router.post('/agencies', validate({ body: v.agency.create }), ctrl.createAgency);
router.get('/agencies/:id', ctrl.getAgency);
router.patch('/agencies/:id', validate({ body: v.agency.update }), ctrl.updateAgency);

router.get('/usage', ctrl.usageSummary);
router.get('/users', ctrl.listUsers);

module.exports = router;
