const express = require('express');
const router = express.Router();
const Review = require('../models/Review');
const Order = require('../models/Order');
const { requireRole } = require('../middleware/adminAuth');
const { audit } = require('../models/AuditLog');

// GET /api/admin/reviews?status=&page=
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = 25, f = {};
  if (['published', 'pending', 'hidden'].includes(req.query.status)) f.status = req.query.status;
  const [rows, total, by] = await Promise.all([Review.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), Review.countDocuments(f), Review.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])]);
  const pubR = await Review.find({ status: 'published' }).select('rating'); const pub = pubR.length ? [{ avg: pubR.reduce((a, r) => a + r.rating, 0) / pubR.length }] : [];
  res.json({ reviews: rows.map((r) => ({ ...r.toObject(), id: r.id })), total, page, pages: Math.max(1, Math.ceil(total / limit)), counts: Object.fromEntries(by.map((x) => [x._id, x.n])), average: pub[0] ? Math.round(pub[0].avg * 10) / 10 : 0 });
});
// GET /api/admin/reviews/to-collect — delivered orders with no review yet (so you can nudge them on WhatsApp)
router.get('/to-collect', async (req, res) => {
  const since = new Date(Date.now() - 90 * 86400000);
  const done = new Set((await Review.find().select('order')).map((r) => String(r.order)));
  const orders = await Order.find({ orderStatus: 'Delivered', updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(200).select('orderNumber customer deliveredAt updatedAt items');
  res.json({ orders: orders.filter((o) => !done.has(String(o._id))).slice(0, 60).map((o) => ({ id: o.id, orderNumber: o.orderNumber, name: o.customer.name, phone: o.customer.phone, email: o.customer.email, deliveredAt: o.deliveredAt || o.updatedAt, items: o.items.map((i) => i.name) })) });
});
router.put('/:id', async (req, res) => {
  const r = await Review.findById(req.params.id); if (!r) return res.status(404).json({ error: 'Review not found' });
  if (req.body.status !== undefined) { if (!['published', 'pending', 'hidden'].includes(req.body.status)) return res.status(400).json({ error: 'Unknown status' }); r.status = req.body.status; }
  if (req.body.featured !== undefined) r.featured = !!req.body.featured;
  await r.save(); await audit({ action: 'review.updated', actor: req.admin.email, entity: 'review', entityId: r.id, summary: `Review ${r.orderNumber}: ${r.status}${r.featured ? ' · featured' : ''}`, req });
  res.json({ ...r.toObject(), id: r.id });
});
// POST /api/admin/reviews/:id/reply {text} — a public reply under the review (empty text removes it)
router.post('/:id/reply', async (req, res) => {
  const r = await Review.findById(req.params.id); if (!r) return res.status(404).json({ error: 'Review not found' });
  const text = String(req.body.text || '').trim().slice(0, 600); r.reply = { text, at: text ? new Date() : null }; await r.save();
  await audit({ action: 'review.replied', actor: req.admin.email, entity: 'review', entityId: r.id, summary: `Reply on review ${r.orderNumber}`, req }); res.json({ ...r.toObject(), id: r.id });
});
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const r = await Review.findById(req.params.id); if (!r) return res.status(404).json({ error: 'Review not found' }); await Review.deleteOne({ _id: r._id });
  await audit({ action: 'review.deleted', actor: req.admin.email, entity: 'review', entityId: r.id, summary: `Review ${r.orderNumber} deleted`, req }); res.json({ ok: true });
});
module.exports = router;
