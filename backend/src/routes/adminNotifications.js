const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');

// GET /api/admin/notifications — the bell: newest 30 that haven't been dismissed. ?archived=1&page= → the saved (dismissed) alerts
router.get('/', async (req, res) => {
  if (req.query.archived) {
    const page = Math.max(1, parseInt(req.query.page) || 1), limit = 30;
    const [items, total] = await Promise.all([Notification.find({ archived: true }).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit), Notification.countDocuments({ archived: true })]);
    return res.json({ notifications: items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  }
  const notifications = await Notification.find({ archived: { $ne: true } }).sort({ read: 1, createdAt: -1 }).limit(30);
  const unreadCount = await Notification.countDocuments({ read: false, archived: { $ne: true } });
  res.json({ notifications, unreadCount });
});
router.put('/read-all', async (req, res) => { await Notification.updateMany({ read: false }, { read: true }); res.json({ ok: true }); });
// × on the bell: save it to the archive instead of showing it on the home page
router.put('/archive-all', async (req, res) => { const r = await Notification.updateMany({ archived: { $ne: true } }, { archived: true, read: true }); res.json({ ok: true, archived: r.modifiedCount ?? r.nModified ?? 0 }); });
router.put('/:id/read', async (req, res) => { await Notification.findByIdAndUpdate(req.params.id, { read: true }); res.json({ ok: true }); });
router.put('/:id/archive', async (req, res) => { await Notification.findByIdAndUpdate(req.params.id, { archived: true, read: true }); res.json({ ok: true }); });
router.put('/:id/restore', async (req, res) => { await Notification.findByIdAndUpdate(req.params.id, { archived: false }); res.json({ ok: true }); });
// permanent delete
router.delete('/archived', async (req, res) => { const r = await Notification.deleteMany({ archived: true }); res.json({ ok: true, deleted: r.deletedCount || 0 }); });
router.delete('/:id', async (req, res) => { await Notification.findByIdAndDelete(req.params.id); res.json({ ok: true }); });

module.exports = router;
