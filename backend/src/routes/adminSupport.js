const express = require('express');
const router = express.Router();
const SupportTicket = require('../models/SupportTicket');
const { STATUSES } = SupportTicket;
const { getSettings } = require('../models/Settings');
const { sendEmail } = require('../utils/email');
const { audit } = require('../models/AuditLog');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/admin/support?status=&q=&page=
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = 25, f = {};
  if (STATUSES.includes(req.query.status)) f.status = req.query.status;
  const q = String(req.query.q || '').trim();
  if (q) f.$or = [{ ticketNumber: new RegExp('^' + rx(q), 'i') }, { orderNumber: new RegExp('^' + rx(q.replace(/^#/, '')), 'i') }, { name: new RegExp(rx(q), 'i') }, { email: new RegExp('^' + rx(q), 'i') }, ...(q.replace(/\D/g, '').length >= 4 ? [{ phone: new RegExp(q.replace(/\D/g, '') + '$') }] : [])];
  const [rows, total, byStatus] = await Promise.all([SupportTicket.find(f).select('-messages').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), SupportTicket.countDocuments(f), SupportTicket.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])]);
  res.json({ tickets: rows.map((t) => t.toObject()).map((t) => ({ ...t, id: String(t._id) })), total, page, pages: Math.ceil(total / limit) || 1, counts: Object.fromEntries(byStatus.map((s) => [s._id, s.n])), statuses: STATUSES });
});
router.get('/:id', async (req, res) => { const t = await SupportTicket.findById(req.params.id); if (!t) return res.status(404).json({ error: 'Ticket not found' }); res.json({ ...t.toObject(), id: t.id }); });

router.put('/:id/status', async (req, res) => {
  if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown status' });
  const t = await SupportTicket.findById(req.params.id); if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const before = t.status; t.status = req.body.status; await t.save();
  await audit({ action: 'support.status_changed', actor: req.admin.email, entity: 'support_ticket', entityId: t.id, summary: `${t.ticketNumber}: ${before} → ${t.status}`, before: { status: before }, after: { status: t.status }, req });
  res.json({ ...t.toObject(), id: t.id });
});

// POST /api/admin/support/:id/reply {text, internal}
router.post('/:id/reply', async (req, res) => {
  const t = await SupportTicket.findById(req.params.id); if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const text = String(req.body.text || '').trim().slice(0, 4000); if (text.length < 2) return res.status(400).json({ error: 'Write a message first' });
  const internal = !!req.body.internal;
  t.messages.push({ from: internal ? 'note' : 'admin', text, by: req.admin.email });
  if (!internal) { if (['New', 'Open', 'InProgress'].includes(t.status)) t.status = 'WaitingCustomer'; }
  else if (t.status === 'New') t.status = 'Open';
  await t.save();
  let emailed = false;
  if (!internal && t.email) {
    const s = await getSettings();
    const r = await sendEmail(t.email, `Re: ${t.subject} [${t.ticketNumber}]`, `<div style="font-family:sans-serif;max-width:560px;color:#2A2620"><p>Hi ${esc(t.name.split(' ')[0])},</p><p style="white-space:pre-wrap">${esc(text)}</p><hr style="border:none;border-top:1px solid #eee"><p style="color:#6B6255;font-size:13px">Reference ${esc(t.ticketNumber)} · reply to this email or write to ${esc(s.email || 'care@thecraftlab.co.in')} · ${esc(s.supportHours)}</p></div>`).catch(() => ({ error: 'failed' }));
    emailed = !(r && (r.skipped || r.error));
  }
  await audit({ action: internal ? 'support.note' : 'support.replied', actor: req.admin.email, entity: 'support_ticket', entityId: t.id, summary: `${internal ? 'Internal note on' : 'Replied to'} ${t.ticketNumber}`, req });
  res.json({ ticket: { ...t.toObject(), id: t.id }, emailed });
});
module.exports = router;
