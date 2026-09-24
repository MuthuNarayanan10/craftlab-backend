const express = require('express');
const router = express.Router();
const Order = require('../models/Order');

// GET /api/track?orderNumber=CL-1001&email=customer@email.com
// Public, but requires BOTH the order number and the email on that order to
// match — prevents anyone from browsing other customers' order details by
// guessing sequential order numbers.
router.get('/', async (req, res) => {
  const { orderNumber, email } = req.query;
  if (!orderNumber || !email) return res.status(400).json({ error: 'orderNumber and email are required' });

  const order = await Order.findOne({
    orderNumber: orderNumber.trim().toUpperCase(),
    'customer.email': email.trim().toLowerCase(),
  });
  if (!order) return res.status(404).json({ error: 'No order found matching that order number and email' });

  // Return only what a customer needs — never the internal Razorpay ids/signature
  res.json({
    orderNumber: order.orderNumber,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    items: order.items.map(i => ({ name: i.name, qty: i.qty, image: i.image })),
    total: order.total,
    delivery: {
      partner: order.delivery.partner,
      trackingId: order.delivery.trackingId,
      dispatchDate: order.delivery.dispatchDate,
      expectedDelivery: order.delivery.expectedDelivery,
    },
    createdAt: order.createdAt,
  });
});

module.exports = router;
