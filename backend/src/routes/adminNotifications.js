const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');

// GET /api/admin/notifications — most recent 30, unread first
router.get('/', async (req, res) => {
  const notifications = await Notification.find().sort({ read: 1, createdAt: -1 }).limit(30);
  const unreadCount = await Notification.countDocuments({ read: false });
  res.json({ notifications, unreadCount });
});

// PUT /api/admin/notifications/:id/read
router.put('/:id/read', async (req, res) => {
  await Notification.findByIdAndUpdate(req.params.id, { read: true });
  res.json({ ok: true });
});

// PUT /api/admin/notifications/read-all
router.put('/read-all', async (req, res) => {
  await Notification.updateMany({ read: false }, { read: true });
  res.json({ ok: true });
});

module.exports = router;
