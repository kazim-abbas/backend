const express = require('express');
const ctrl = require('../controllers/auth.controller');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');
const v = require('../validators');

const router = express.Router();

router.post('/register', validate({ body: v.auth.register }), ctrl.register);
router.post('/login', validate({ body: v.auth.login }), ctrl.login);
router.get('/me', authenticate, ctrl.me);

module.exports = router;
