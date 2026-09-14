const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const { verifyPaymentSignature, verifyWebhookSignature } = require('../utils/razorpay');
const { logAction } = require('../models/AuditLog');

/** Marks an order paid and permanently deducts stock. Idempotent — if the
 *  order is already Paid (e.g. the callback AND the webhook both fire for
 *  the same payment), this safely does nothing on the second call. */
async function markOrderPaid(order, { razorpay_payment_id, razorpay_signature, method, via }) {
  if (order.paymentStatus === 'Paid') return order; // already processed — idempotent

  order.paymentStatus = 'Paid';
  order.orderStatus = 'Paid';
  order.payment.razorpayPaymentId = razorpay_payment_id;
  order.payment.razorpaySignature = razorpay_signature || '';
  order.payment.method = method || '';
  order.payment.verifiedAt = new Date();
  order.payment.verifiedVia = via;
  await order.save();

  // Convert reservation into a permanent stock deduction.
  for (const item of order.items) {
    await Product.findByIdAndUpdate(item.product, { $inc: { stock: -item.qty, reserved: -item.qty } });
  }

  if (order.cartId) {
    await Cart.findOneAndUpdate({ cartId: order.cartId }, { status: 'converted', convertedToOrder: order._id });
  }

  await logAction('order.paid', via, { orderNumber: order.orderNumber, paymentId: razorpay_payment_id });
  return order;
}

// POST /api/payments/verify — called by the frontend right after Razorpay Checkout succeeds.
// This is the standard secure pattern: verify the signature server-side before trusting "success".
router.post('/verify', async (req, res) => {
  const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const valid = verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
  if (!valid) return res.status(400).json({ error: 'Payment signature verification failed' });

  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.payment.razorpayOrderId !== razorpay_order_id) {
    return res.status(400).json({ error: 'Order/payment mismatch' });
  }

  await markOrderPaid(order, { razorpay_payment_id, razorpay_signature, via: 'checkout-callback' });
  res.json({ verified: true, orderNumber: order.orderNumber });
});

// POST /api/webhooks/razorpay — server-to-server confirmation, independent of whether
// the customer's browser stayed connected long enough for the callback above to fire.
// Mounted with express.raw() in server.js so we can verify the exact raw signature.
router.post('/razorpay', async (req, res) => {
  const signature = req.header('x-razorpay-signature');
  const rawBody = req.body; // Buffer, thanks to express.raw()

  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  const payload = JSON.parse(rawBody.toString('utf8'));
  const event = payload.event;

  if (event === 'payment.captured') {
    const payment = payload.payload.payment.entity;
    const order = await Order.findOne({ 'payment.razorpayOrderId': payment.order_id });
    if (order) {
      await markOrderPaid(order, {
        razorpay_payment_id: payment.id,
        method: payment.method,
        via: 'webhook',
      });
    }
  } else if (event === 'payment.failed') {
    const payment = payload.payload.payment.entity;
    const order = await Order.findOne({ 'payment.razorpayOrderId': payment.order_id });
    if (order && order.paymentStatus !== 'Paid') {
      order.paymentStatus = 'Failed';
      await order.save();
      await logAction('order.payment_failed', 'webhook', { orderNumber: order.orderNumber });
    }
  }

  res.json({ received: true });
});

module.exports = router;
