const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Product = require('../models/Product');
const { logAction } = require('../models/AuditLog');
const { sendEmail, orderStatusEmail } = require('../utils/email');

// GET /api/admin/orders?status=Paid
router.get('/', async (req, res) => {
  const filter = {};
  if (req.query.status) filter.orderStatus = req.query.status;
  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(500);
  res.json(orders);
});

// GET /api/admin/orders/:id
router.get('/:id', async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// PUT /api/admin/orders/:id/status
router.put('/:id/status', async (req, res) => {
  const { orderStatus } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const previous = order.orderStatus;
  order.orderStatus = orderStatus;

  // If an admin cancels/refunds a paid order manually, release/return stock accordingly.
  if (orderStatus === 'Cancelled' && previous !== 'Cancelled' && order.paymentStatus !== 'Refunded') {
    for (const item of order.items) {
      await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
    }
  }

  await order.save();
  await logAction('order.status_changed', req.admin.email, { orderNumber: order.orderNumber, from: previous, to: orderStatus });

  if (['Dispatched', 'Delivered', 'Cancelled'].includes(orderStatus)) {
    const { subject, html } = orderStatusEmail(order);
    sendEmail(order.customer.email, subject, html); // fire-and-forget
  }

  res.json(order);
});

// PUT /api/admin/orders/:id/delivery — manual delivery details
router.put('/:id/delivery', async (req, res) => {
  const { partner, trackingId, dispatchDate, expectedDelivery, notes } = req.body;
  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { delivery: { partner, trackingId, dispatchDate, expectedDelivery, notes } },
    { new: true }
  );
  if (!order) return res.status(404).json({ error: 'Order not found' });
  await logAction('order.delivery_updated', req.admin.email, { orderNumber: order.orderNumber });
  res.json(order);
});

// POST /api/admin/orders/release-stale — releases inventory reservations for
// orders that have sat Pending too long (customer likely abandoned checkout
// before paying). Run manually from the admin dashboard; can later be wired
// to a scheduled job if order volume makes that worthwhile.
router.post('/release-stale', async (req, res) => {
  const cutoffMinutes = parseInt(req.body.cutoffMinutes) || 30;
  const cutoff = new Date(Date.now() - cutoffMinutes * 60 * 1000);
  const staleOrders = await Order.find({
    orderStatus: 'Pending',
    paymentStatus: 'Pending',
    createdAt: { $lt: cutoff },
  });

  for (const order of staleOrders) {
    for (const item of order.items) {
      await Product.findByIdAndUpdate(item.product, { $inc: { reserved: -item.qty } });
    }
    order.orderStatus = 'Cancelled';
    await order.save();
  }

  await logAction('orders.stale_released', req.admin.email, { count: staleOrders.length });
  res.json({ released: staleOrders.length });
});

module.exports = router;
