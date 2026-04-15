const express = require('express');
const authRoutes = require('./auth.routes');
const ticketsRoutes = require('./tickets.routes');
const aiRoutes = require('./ai.routes');
const adminRoutes = require('./admin.routes');
const agencyRoutes = require('./agency.routes');
const articlesRoutes = require('./articles.routes');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

router.use('/auth', authRoutes);
router.use('/tickets', ticketsRoutes);
router.use('/ai', aiRoutes);
router.use('/admin', adminRoutes);
router.use('/agency', agencyRoutes);
router.use('/articles', articlesRoutes);

module.exports = router;
