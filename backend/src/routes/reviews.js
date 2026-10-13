const express = require('express');
const router = express.Router();
const Review = require('../models/Review');
const Order = require('../models/Order');
const { createNotification } = require('../models/Notification');
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function summary() {
  const rows = await Review.aggregate([{ $match: { status: 'published' } }, { $group: { _id: '$rating', n: { $sum: 1 } } }]);
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let count = 0, sum = 0;
  for (const r of rows) { dist[r._id] = r.n; count += r.n; sum += r._id * r.n; }
  return { count, average: count ? Math.round((sum / count) * 10) / 10 : 0, distribution: dist };
}
// GET /api/reviews?page=&limit=&featured=1 — what customers have said (public)
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(24, Math.max(1, parseInt(req.query.limit) || 12));
  const f = { status: 'published' }; if (req.query.featured) f.featured = true;
  const [rows, total, sm] = await Promise.all([Review.find(f).sort({ featured: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit), Review.countDocuments(f), summary()]);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ reviews: rows.map((r) => r.toPublic()), total, page, pages: Math.max(1, Math.ceil(total / limit)), ...sm });
});
// POST /api/reviews — the customer proves it's their order (order number + the email or mobile used on it); sending again edits their review
router.post('/', async (req, res) => {
  const b = req.body || {};
  const orderNumber = clean(b.orderNumber, 24).toUpperCase().replace(/^#/, '').replace(/\s+/g, '');
  const email = clean(b.email, 120).toLowerCase(), phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
  if (!orderNumber || (!email && phone.length !== 10)) return res.status(400).json({ error: 'Enter your order number and the email or mobile number used for the order' });
  const rating = parseInt(b.rating, 10); if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Please choose a star rating' });
  const text = clean(b.text, 1500); if (text.length < 5) return res.status(400).json({ error: 'Please write a line or two about your experience' });
  const order = await Order.findOne({ orderNumber: { $in: [orderNumber, orderNumber.replace(/-/g, '')] }, ...(email ? { 'customer.email': email } : { 'customer.phone': { $regex: phone + '$' } }) });
  if (!order) return res.status(404).json({ error: 'No order found matching those details' });
  if (!['Dispatched', 'InTransit', 'OutForDelivery', 'Delivered'].includes(order.orderStatus)) return res.status(400).json({ error: 'You can review your order once it has been shipped' });
  const first = String(order.customer.name || 'Customer').trim().split(/\s+/);
  const given = clean(b.displayName, 40).replace(/[<>]/g, '');
  const name = given || (first[0] + (first[1] ? ' ' + first[1][0].toUpperCase() + '.' : ''));
  const hasLink = /https?:\/\/|www\.|\.(com|in|net|org)\b/i.test(text + ' ' + clean(b.title, 90));
  const data = { order: order._id, orderNumber: order.orderNumber, customerId: order.customerId || null, name, city: order.address?.city || '', rating, title: clean(b.title, 90), text, items: order.items.map((i) => i.name).slice(0, 5) };
  let r = await Review.findOne({ order: order._id }); const edited = !!r;
  if (r) { Object.assign(r, data); if (r.status === 'hidden') { /* stays hidden: the owner took it down */ } else r.status = hasLink ? 'pending' : 'published'; await r.save(); }
  else r = await Review.create({ ...data, status: hasLink ? 'pending' : 'published' });
  await createNotification('review_submitted', `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} review from ${name} for ${order.orderNumber}${hasLink ? ' (held — contains a link)' : ''}`, { orderNumber: order.orderNumber });
  res.status(edited ? 200 : 201).json({ ok: true, edited, status: r.status, message: r.status === 'published' ? 'Thank you! Your review is now live.' : 'Thank you! Your review will appear once we have taken a quick look.' });
});
module.exports = router;
