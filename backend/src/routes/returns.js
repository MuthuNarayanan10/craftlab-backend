const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Return = require('../models/Return');
const { createNotification } = require('../models/Notification');
const { requireCustomer } = require('../middleware/customerAuth');

// POST /api/returns — logged-in customers only, must own the order
router.post('/', requireCustomer, async (req, res) => {
  const { orderId, reason, comments } = req.body;
  if (!orderId || !reason) return res.status(400).json({ error: 'orderId and reason are required' });

  const order = await Order.findOne({ _id: orderId, customerId: req.customer.id });
  if (!order) return res.status(404).json({ error: 'Order not found on your account' });
  if (order.orderStatus !== 'Delivered') return res.status(400).json({ error: 'Returns can only be requested for delivered orders' });

  const existing = await Return.findOne({ order: order._id });
  if (existing) return res.status(409).json({ error: 'A return request already exists for this order', status: existing.status });

  const returnReq = await Return.create({
    order: order._id,
    orderNumber: order.orderNumber,
    customerId: req.customer.id,
    customerEmail: order.customer.email,
    items: order.items.map(i => ({ name: i.name, qty: i.qty })),
    reason, comments: comments || '',
  });

  await createNotification('return_requested', `Return requested for ${order.orderNumber}`, { orderNumber: order.orderNumber });
  res.status(201).json(returnReq);
});

// GET /api/returns/mine — this customer's own return requests
router.get('/mine', requireCustomer, async (req, res) => {
  const returns = await Return.find({ customerId: req.customer.id }).sort({ createdAt: -1 });
  res.json(returns);
});

module.exports = router;
