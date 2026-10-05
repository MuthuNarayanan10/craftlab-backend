const express = require('express');
const router = express.Router();
const Return = require('../models/Return');
const Order = require('../models/Order');
const { requireRole } = require('../middleware/adminAuth');
const { STATUSES, LABEL, canTransition, allowedNext, normalize } = require('../utils/returnStatus');
const { issueRefund, RefundError } = require('../utils/refundService');
const { getPaymentProvider } = require('../utils/paymentProvider');
const { adjustStock } = require('../services/inventory');
const { notifyOrder } = require('../services/notifier');
const { audit } = require('../models/AuditLog');
const { pushEvent } = require('../utils/orderEvents');

const NOTIFY = { APPROVED: 'return_approved', PICKUP_SCHEDULED: 'return_pickup', REJECTED: 'return_rejected' };
const slim = (r) => { const o = r.toJSON(); o.status = normalize(o.status); o.imageCount = o.imageCount || (o.images || []).length; delete o.images; o.allowedNext = allowedNext(o.status); return o; };

// GET /api/admin/returns?status=&q=&page=&limit=
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, parseInt(req.query.limit) || 25);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.q) { const q = String(req.query.q).trim(); filter.$or = [{ orderNumber: new RegExp('^' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { customerPhone: new RegExp(q.replace(/\D/g, '') + '$') }]; }
  const [docs, total, byStatus] = await Promise.all([
    Return.find(filter).select('-images').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Return.countDocuments(filter),
    Return.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const counts = {}; for (const s of byStatus) counts[normalize(s._id)] = (counts[normalize(s._id)] || 0) + s.n;
  res.json({ returns: docs.map(slim), total, page, pages: Math.ceil(total / limit) || 1, counts, statuses: STATUSES, labels: LABEL });
});

// GET /api/admin/returns/:id — full detail incl. photos and the order
router.get('/:id', async (req, res) => {
  const r = await Return.findById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Return request not found' });
  const order = await Order.findById(r.order).select('orderNumber total subtotal refundedAmount refunds payment paymentStatus items');
  const o = r.toJSON(); o.status = normalize(o.status); o.allowedNext = allowedNext(o.status);
  res.json({ ...o, order: order ? order.toJSON() : null, labels: LABEL });
});

// PUT /api/admin/returns/:id/status
router.put('/:id/status', async (req, res) => {
  const { status, note, rejectionReason, pickup, inspection } = req.body;
  const ret = await Return.findById(req.params.id);
  if (!ret) return res.status(404).json({ error: 'Return request not found' });
  const from = normalize(ret.status);
  const check = canTransition(from, status);
  if (!check.ok) return res.status(409).json({ error: check.reason });
  if (status === 'REFUNDED') return res.status(400).json({ error: 'Use “Issue refund” — a return is marked refunded only once the refund has been created.' });
  if (status === 'REJECTED' && !String(rejectionReason || '').trim()) return res.status(400).json({ error: 'Tell the customer why the return isn’t approved' });

  if (status === 'REJECTED') ret.rejectionReason = String(rejectionReason).trim();
  if (pickup) { ret.pickup.scheduledAt = pickup.scheduledAt ? new Date(pickup.scheduledAt) : ret.pickup.scheduledAt; ret.pickup.courier = pickup.courier || ret.pickup.courier; ret.pickup.awb = pickup.awb || ret.pickup.awb; ret.pickup.selfShip = !!pickup.selfShip; }
  if (inspection) { ret.inspection.result = inspection.result || ret.inspection.result; ret.inspection.notes = inspection.notes ?? ret.inspection.notes; ret.inspection.restock = !!inspection.restock; }

  // restock once, when the item has been received and checked
  if (['REFUND_PENDING', 'CLOSED'].includes(status) && ret.inspection.restock && !ret.inspection.restocked) {
    for (const it of ret.items) { const order = await Order.findById(ret.order); const line = order.items[it.index]; if (line) await adjustStock(line.product, it.qty, { reason: 'return_restock', ref: ret.orderNumber, actor: req.admin.email, note: 'Returned item passed inspection' }); }
    ret.inspection.restocked = true;
  }
  ret.status = status;
  ret.history.push({ status, actor: req.admin.email, note: String(note || rejectionReason || '').slice(0, 300) });
  await ret.save();
  if (NOTIFY[status]) { const order = await Order.findById(ret.order); if (order) notifyOrder(NOTIFY[status], { order, ret }); }
  await audit({ action: 'return.status_changed', actor: req.admin.email, entity: 'return', entityId: ret.id, summary: `Return for ${ret.orderNumber}: ${LABEL[from]} → ${LABEL[status]}`, before: { status: from }, after: { status }, req });
  res.json(slim(ret));
});

// POST /api/admin/returns/:id/refund — creates the refund through Razorpay (online) or records it (COD). Owner only.
router.post('/:id/refund', requireRole('ADMIN'), async (req, res) => {
  const ret = await Return.findById(req.params.id);
  if (!ret) return res.status(404).json({ error: 'Return request not found' });
  if (normalize(ret.status) !== 'REFUND_PENDING') return res.status(409).json({ error: 'Move the return to “Refund being processed” first (after the item is received and checked)' });
  if (ret.resolution === 'Replacement' && !req.body.confirmRefundInstead) return res.status(409).json({ error: 'This customer asked for a replacement. Close the return after sending it, or confirm you are refunding instead.' });
  const order = await Order.findById(ret.order);
  const amount = req.body.amount !== undefined ? Number(req.body.amount) : ret.amount;
  try {
    const rec = await issueRefund(order, { amount, reason: ret.reason, actor: req.admin.email, returnId: ret.id, reference: String(req.body.reference || '') }, getPaymentProvider());
    if (order.paymentStatus === 'Refunded') { order.orderStatus = 'Refunded'; pushEvent(order, { label: 'Order fully refunded', actor: req.admin.email, type: 'status' }); }
    await order.save();
    ret.refund = { amount: rec.amount, refundId: rec.refundId, status: rec.status, issuedAt: new Date() };
    if (rec.status === 'processed') { ret.status = 'REFUNDED'; ret.history.push({ status: 'REFUNDED', actor: req.admin.email, note: `₹${rec.amount} refunded` }); }
    else ret.history.push({ status: 'REFUND_PENDING', actor: req.admin.email, note: `Refund of ₹${rec.amount} created — waiting for the bank`, visible: true });
    await ret.save();
    notifyOrder('refund_initiated', { order, ret, refund: rec });
    await audit({ action: 'refund.issued', actor: req.admin.email, entity: 'order', entityId: order.id, summary: `Refunded Order ${order.orderNumber} — ₹${rec.amount}`, after: { refundId: rec.refundId, method: rec.method }, req });
    res.json({ refund: rec, return: slim(ret) });
  } catch (e) {
    if (e instanceof RefundError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

module.exports = router;
