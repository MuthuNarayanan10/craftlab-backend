const express = require('express');
const crypto = require('crypto');
const router = express.Router();        // /api/payments/*
const webhookRouter = express.Router(); // /api/webhooks/razorpay (mounted with a raw-body parser)
const Order = require('../models/Order');
const WebhookEvent = require('../models/WebhookEvent');
const Return = require('../models/Return');
const { getPaymentProvider } = require('../utils/paymentProvider');
const { confirmPayment } = require('../services/orderService');
const { notifyOrder } = require('../services/notifier');
const { applyRefundStatus } = require('../utils/refundService');
const { pushEvent } = require('../utils/orderEvents');
const { createNotification } = require('../models/Notification');
const { logger } = require('../utils/logger');

// POST /api/payments/verify — called by the browser right after Razorpay Checkout succeeds.
// The signature is checked on the server; the browser's word alone never marks an order paid.
router.post('/verify', async (req, res) => {
  const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!getPaymentProvider().verifyCheckoutSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature })) {
    return res.status(400).json({ error: 'Payment signature verification failed' });
  }
  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.payment.razorpayOrderId !== razorpay_order_id) return res.status(400).json({ error: 'Order/payment mismatch' });
  await confirmPayment(order.id, { paymentId: razorpay_payment_id, signature: razorpay_signature, via: 'checkout-callback', actor: 'customer' });
  res.json({ verified: true, orderNumber: order.orderNumber });
});

// POST /api/webhooks/razorpay — server-to-server. Mounted with express.raw() so the signature is checked over the exact bytes.
// Idempotent: Razorpay may deliver the same event several times; each event id is processed once.
webhookRouter.post('/', async (req, res) => {
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !getPaymentProvider().verifyWebhookSignature(raw, req.header('x-razorpay-signature'))) return res.status(400).json({ error: 'Invalid webhook signature' });

  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Bad payload' }); }
  const event = payload.event;
  const eventId = req.header('x-razorpay-event-id') || crypto.createHash('sha256').update(raw).digest('hex');

  try { await WebhookEvent.create({ provider: 'razorpay', eventId, type: event }); }
  catch (e) {
    if (e.code !== 11000) throw e;
    const prior = await WebhookEvent.findOneAndUpdate({ provider: 'razorpay', eventId, status: 'failed' }, { status: 'processing', error: '' });
    if (!prior) return res.json({ received: true, duplicate: true }); // already handled (or being handled)
  }

  try {
    const ref = await handle(event, payload.payload || {});
    await WebhookEvent.updateOne({ provider: 'razorpay', eventId }, { status: ref === null ? 'ignored' : 'processed', ref: ref || '' });
    res.json({ received: true });
  } catch (e) {
    logger.error('webhook_failed', { event, eventId, error: e.message });
    await WebhookEvent.updateOne({ provider: 'razorpay', eventId }, { status: 'failed', error: String(e.message).slice(0, 300) });
    await createNotification('payment_failed', `Razorpay webhook "${event}" failed to process: ${e.message}`, { eventId }).catch(() => {});
    res.status(500).json({ error: 'Processing failed — will be retried' }); // non-2xx makes Razorpay retry
  }
});

async function handle(event, body) {
  if (event === 'payment.captured' || event === 'order.paid') {
    const pay = body.payment?.entity;
    if (!pay) return null;
    const order = await Order.findOne({ 'payment.razorpayOrderId': pay.order_id });
    if (!order) return null;
    // never trust an event whose amount differs from what we asked for
    if (pay.amount !== Math.round(order.total * 100) || pay.currency !== 'INR') {
      pushEvent(order, { label: 'Payment amount did not match the order', actor: 'razorpay', public: false, type: 'payment_mismatch', note: `expected ${Math.round(order.total * 100)}, got ${pay.amount}` });
      await order.save();
      await createNotification('payment_failed', `Razorpay amount mismatch on ${order.orderNumber} — review manually`, { orderNumber: order.orderNumber });
      throw new Error(`Amount mismatch on ${order.orderNumber}`);
    }
    await confirmPayment(order.id, { paymentId: pay.id, method: pay.method, via: 'webhook' });
    return order.orderNumber;
  }
  if (event === 'payment.failed') {
    const pay = body.payment?.entity;
    const order = pay && (await Order.findOne({ 'payment.razorpayOrderId': pay.order_id }));
    if (!order) return null;
    if (order.paymentStatus !== 'Paid') {
      order.paymentStatus = 'Failed';
      pushEvent(order, { label: 'Payment attempt failed', actor: 'razorpay', public: true, type: 'payment', note: pay.error_description || '' });
      await order.save();
      await createNotification('payment_failed', `Payment failed for order ${order.orderNumber}`, { orderNumber: order.orderNumber });
    }
    return order.orderNumber;
  }
  if (event === 'refund.processed' || event === 'refund.failed' || event === 'refund.created') {
    const rf = body.refund?.entity;
    if (!rf) return null;
    const order = await Order.findOne({ 'payment.razorpayPaymentId': rf.payment_id });
    if (!order) return null;
    const status = event === 'refund.failed' ? 'failed' : event === 'refund.processed' ? 'processed' : 'pending';
    if (applyRefundStatus(order, rf.id, status)) {
      await order.save();
      const rec = order.refunds.find((r) => r.refundId === rf.id);
      if (rec?.returnId) { // finish the linked return only once the bank/Razorpay confirms the money moved
        const ret = await Return.findById(rec.returnId);
        if (ret) {
          ret.refund.status = status;
          if (status === 'processed' && ret.status !== 'REFUNDED') { ret.status = 'REFUNDED'; ret.history.push({ status: 'REFUNDED', actor: 'razorpay', note: `₹${rec.amount} refunded` }); }
          if (status === 'failed') ret.history.push({ status: 'REFUND_PENDING', actor: 'razorpay', note: 'Refund failed — we are looking into it', visible: true });
          await ret.save();
        }
      }
      if (status === 'processed') notifyOrder('refund_completed', { order, refund: { refundId: rf.id, amount: rf.amount / 100 } });
    }
    return order.orderNumber;
  }
  return null; // event we don't act on
}

module.exports = router;
module.exports.webhookRouter = webhookRouter;
