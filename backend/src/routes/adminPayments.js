const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const WebhookEvent = require('../models/WebhookEvent');
const { requireRole } = require('../middleware/adminAuth');
const { issueRefund, RefundError } = require('../utils/refundService');
const { getPaymentProvider } = require('../utils/paymentProvider');
const { reconcilePending } = require('../services/reconcile');
const { notifyOrder } = require('../services/notifier');
const { pushEvent } = require('../utils/orderEvents');
const { audit } = require('../models/AuditLog');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/admin/payments?status=&mode=&q=&page=
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, parseInt(req.query.limit) || 25);
  const filter = {};
  if (['Pending', 'Paid', 'Failed', 'Refunded'].includes(req.query.status)) filter.paymentStatus = req.query.status;
  if (req.query.mode === 'cod') filter['payment.method'] = 'cod'; else if (req.query.mode === 'online') filter['payment.method'] = { $ne: 'cod' };
  if (req.query.refunds === '1') filter['refunds.0'] = { $exists: true };
  const q = String(req.query.q || '').trim();
  if (q) filter.$or = [{ orderNumber: new RegExp('^' + esc(q), 'i') }, { 'payment.razorpayPaymentId': q }, { 'payment.razorpayOrderId': q }, { 'customer.name': new RegExp(esc(q), 'i') }];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [docs, total, agg] = await Promise.all([
    Order.find(filter).select('orderNumber customer total paymentStatus payment refunds refundedAmount createdAt').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Order.countDocuments(filter),
    Order.aggregate([{ $group: { _id: '$paymentStatus', n: { $sum: 1 }, amount: { $sum: '$total' } } }]),
  ]);
  res.json({
    payments: docs.map((o) => ({ id: o.id, orderNumber: o.orderNumber, customer: o.customer.name, phone: o.customer.phone, amount: o.total, method: o.payment.method === 'cod' ? 'COD' : (o.payment.razorpayMethod || 'Online'), isCod: o.payment.method === 'cod', paymentStatus: o.paymentStatus, razorpayOrderId: o.payment.razorpayOrderId, razorpayPaymentId: o.payment.razorpayPaymentId, verifiedVia: o.payment.verifiedVia, verifiedAt: o.payment.verifiedAt, refundedAmount: o.refundedAmount, refunds: o.refunds, createdAt: o.createdAt })),
    total, page, pages: Math.ceil(total / limit) || 1,
    summary: Object.fromEntries(agg.map((a) => [a._id, { count: a.n, amount: a.amount }])),
  });
});

// POST /api/admin/payments/reconcile — ask Razorpay about every unconfirmed online payment and fix what was missed
router.post('/reconcile', async (req, res) => {
  const r = await reconcilePending({ olderThanMin: 2 });
  await audit({ action: 'payments.reconciled', actor: req.admin.email, summary: `Reconciliation: ${r.recovered} recovered of ${r.checked} checked`, req });
  res.json(r);
});

// POST /api/admin/payments/orders/:id/refund {amount, reason, reference} — goodwill / partial / full refund, owner only
router.post('/orders/:id/refund', requireRole('ADMIN'), async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const rec = await issueRefund(order, { amount: req.body.amount, reason: String(req.body.reason || 'Refund').slice(0, 200), actor: req.admin.email, reference: String(req.body.reference || '') }, getPaymentProvider());
    if (order.paymentStatus === 'Refunded' && order.orderStatus !== 'Cancelled') { order.orderStatus = 'Refunded'; pushEvent(order, { label: 'Order fully refunded', actor: req.admin.email, type: 'status' }); }
    await order.save();
    notifyOrder('refund_initiated', { order, refund: rec });
    await audit({ action: 'refund.issued', actor: req.admin.email, entity: 'order', entityId: order.id, summary: `Refunded Order ${order.orderNumber} — ₹${rec.amount}`, after: { refundId: rec.refundId, method: rec.method, reason: rec.reason }, req });
    res.json({ refund: rec, refundedAmount: order.refundedAmount, paymentStatus: order.paymentStatus });
  } catch (e) { if (e instanceof RefundError) return res.status(e.status).json({ error: e.message }); throw e; }
});

// GET /api/admin/payments/webhooks — recent webhook deliveries (so a failing webhook is never invisible)
router.get('/webhooks', async (req, res) => {
  const events = await WebhookEvent.find().sort({ createdAt: -1 }).limit(50);
  res.json(events.map((e) => ({ provider: e.provider, type: e.type, status: e.status, error: e.error, ref: e.ref, at: e.createdAt })));
});
module.exports = router;
