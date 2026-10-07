const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const GiftCard = require('../models/GiftCard');
const RewardLedger = require('../models/RewardLedger');
const { requireRole } = require('../middleware/adminAuth');
const { getSettings } = require('../models/Settings');
const { sendEmail } = require('../utils/email');
const rewards = require('../services/rewards');
const { audit } = require('../models/AuditLog');
const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// GET /api/admin/rewards/summary — what you owe customers in points and gift cards
router.get('/summary', async (req, res) => {
  const [pts, holders, cards, cardCount] = await Promise.all([Customer.aggregate([{ $group: { _id: null, points: { $sum: '$rewardPoints' }, pending: { $sum: '$rewardPending' } } }]), Customer.countDocuments({ rewardPoints: { $gt: 0 } }), GiftCard.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, balance: { $sum: '$balance' } } }]), GiftCard.countDocuments({ status: 'active', balance: { $gt: 0 } })]);
  const p = pts[0] || {}, g = cards[0] || {};
  res.json({ pointsOutstanding: p.points || 0, pointsPending: p.pending || 0, pointHolders: holders, pointsLiability: p.points || 0, giftCardsActive: cardCount, giftCardLiability: g.balance || 0 });
});

// GET /api/admin/rewards/customers?q= — find a customer and see their wallet
router.get('/customers', async (req, res) => {
  const q = String(req.query.q || '').trim(); if (q.length < 3) return res.json([]);
  const digits = q.replace(/\D/g, '');
  const rows = await Customer.find({ $or: [{ email: new RegExp('^' + rx(q.toLowerCase())) }, { name: new RegExp(rx(q), 'i') }, ...(digits.length >= 4 ? [{ phone: new RegExp(digits + '$') }] : [])] }).limit(10);
  res.json(rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, points: c.rewardPoints || 0, pending: c.rewardPending || 0 })));
});
router.get('/customers/:id', async (req, res) => {
  const c = await Customer.findById(req.params.id); if (!c) return res.status(404).json({ error: 'Customer not found' });
  const ledger = await RewardLedger.find({ customerId: c.id }).sort({ createdAt: -1 }).limit(100);
  res.json({ id: c.id, name: c.name, phone: c.phone, email: c.email, points: c.rewardPoints || 0, pending: c.rewardPending || 0, ledger });
});
router.post('/customers/:id/adjust', requireRole('ADMIN'), async (req, res) => {
  try {
    const c = await rewards.adjust(req.params.id, Number(req.body.points), req.body.note, req.admin.email);
    await audit({ action: 'rewards.adjusted', actor: req.admin.email, entity: 'customer', entityId: c.id, summary: `${req.body.points > 0 ? '+' : ''}${req.body.points} points for ${c.name || c.phone || c.email}: ${String(req.body.note || '').slice(0, 80)}`, req });
    res.json({ points: c.rewardPoints, pending: c.rewardPending });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------------- gift cards ---------------- */
router.get('/gift-cards', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = 25, f = {}; const q = String(req.query.q || '').trim();
  if (['active', 'disabled'].includes(req.query.status)) f.status = req.query.status;
  if (q) f.$or = [{ code: new RegExp(rx(q.toUpperCase().replace(/\s/g, ''))) }, { recipientEmail: new RegExp('^' + rx(q.toLowerCase())) }, { recipientName: new RegExp(rx(q), 'i') }];
  const [rows, total] = await Promise.all([GiftCard.find(f).select('-history').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), GiftCard.countDocuments(f)]);
  res.json({ cards: rows.map((c) => c.toJSON()), total, page, pages: Math.ceil(total / limit) || 1 });
});
router.get('/gift-cards/:id', async (req, res) => { const c = await GiftCard.findById(req.params.id); if (!c) return res.status(404).json({ error: 'Gift card not found' }); res.json(c.toJSON()); });

// POST /api/admin/rewards/gift-cards {amount, count, expiryMonths, recipientName, recipientEmail, note, sendEmail} — owner only
router.post('/gift-cards', requireRole('ADMIN'), async (req, res) => {
  const amount = Number(req.body.amount), count = Math.min(50, Math.max(1, parseInt(req.body.count) || 1)), months = req.body.expiryMonths === 0 || req.body.expiryMonths === '0' ? 0 : Math.min(60, Math.max(1, parseInt(req.body.expiryMonths) || 12));
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return res.status(400).json({ error: 'Gift card value must be a whole number of rupees from ₹1 to ₹1,00,000' });
  const email = String(req.body.recipientEmail || '').trim().toLowerCase(); if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a valid recipient email' });
  if (count > 1 && email) return res.status(400).json({ error: 'Issue one card at a time when emailing a recipient' });
  const expiresAt = months ? new Date(Date.now() + months * 30.4375 * 86400e3) : null, made = [];
  for (let i = 0; i < count; i++) {
    for (let tries = 0; tries < 5; tries++) { try { made.push(await GiftCard.create({ code: GiftCard.newCode(), initialAmount: amount, balance: amount, expiresAt, recipientName: String(req.body.recipientName || '').slice(0, 80), recipientEmail: email, note: String(req.body.note || '').slice(0, 200), createdBy: req.admin.email, history: [{ type: 'issue', amount, actor: req.admin.email }] })); break; } catch (e) { if (e.code !== 11000) throw e; } }
  }
  let emailed = false;
  if (req.body.sendEmail && email && made[0]) {
    const s = await getSettings(), g = made[0];
    const r = await sendEmail(email, `Your ${s.businessName || 'The Craft Lab'} gift card — ₹${amount}`, `<div style="font-family:sans-serif;max-width:520px;color:#2A2620"><h2 style="color:#544C35;font-weight:500">A gift for you${g.recipientName ? ', ' + esc(g.recipientName) : ''}</h2><p>You’ve received a gift card worth <strong>₹${amount}</strong>.</p><p style="font-size:26px;letter-spacing:3px;font-weight:700;background:#f5f1e7;padding:16px;border-radius:10px;text-align:center">${esc(g.code)}</p><p>Enter this code at checkout on ${esc(s.siteUrl || 'our website')}. ${g.expiresAt ? 'Valid until ' + g.expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) + '.' : ''} Any balance left stays on the card.</p></div>`).catch(() => null);
    emailed = !!r && !r.skipped && !r.error;
  }
  await audit({ action: 'giftcard.issued', actor: req.admin.email, entity: 'gift_card', entityId: made[0]?.id, summary: `Issued ${made.length} gift card${made.length > 1 ? 's' : ''} of ₹${amount}`, req });
  res.status(201).json({ cards: made.map((c) => c.toJSON()), emailed });
});
// PUT /api/admin/rewards/gift-cards/:id {status, expiresAt, adjust, note} — owner only
router.put('/gift-cards/:id', requireRole('ADMIN'), async (req, res) => {
  const c = await GiftCard.findById(req.params.id); if (!c) return res.status(404).json({ error: 'Gift card not found' });
  if (req.body.status) { if (!['active', 'disabled'].includes(req.body.status)) return res.status(400).json({ error: 'Status must be active or disabled' }); c.status = req.body.status; c.history.push({ type: req.body.status === 'active' ? 'enabled' : 'disabled', actor: req.admin.email }); }
  if (req.body.expiresAt !== undefined) c.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  if (req.body.adjust !== undefined) { const a = Math.trunc(Number(req.body.adjust)); if (!a || c.balance + a < 0 || c.balance + a > 100000) return res.status(400).json({ error: 'That adjustment would take the balance outside ₹0 – ₹1,00,000' }); c.balance += a; c.history.push({ type: 'adjust', amount: a, actor: req.admin.email }); }
  await c.save(); await audit({ action: 'giftcard.updated', actor: req.admin.email, entity: 'gift_card', entityId: c.id, summary: `Gift card …${c.code.slice(-4)} updated`, req });
  res.json(c.toJSON());
});
module.exports = router;
