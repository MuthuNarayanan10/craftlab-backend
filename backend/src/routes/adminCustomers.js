const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const Order = require('../models/Order');

// GET /api/admin/customers
router.get('/', async (req, res) => {
  const customers = await Customer.find().sort({ createdAt: -1 });
  const withStats = await Promise.all(customers.map(async c => {
    const orders = await Order.find({ customerId: c._id, paymentStatus: 'Paid' });
    return {
      ...c.toJSON(),
      orderCount: orders.length,
      totalSpend: orders.reduce((s, o) => s + o.total, 0),
      lastOrderAt: orders.length ? orders.sort((a, b) => b.createdAt - a.createdAt)[0].createdAt : null,
    };
  }));
  res.json(withStats);
});

// GET /api/admin/customers/:id
router.get('/:id', async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const orders = await Order.find({ customerId: customer._id }).sort({ createdAt: -1 });
  res.json({ ...customer.toJSON(), orders });
});

// PUT /api/admin/customers/:id/status — block/unblock
router.put('/:id/status', async (req, res) => {
  const { status } = req.body;
  const customer = await Customer.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json(customer);
});

module.exports = router;
