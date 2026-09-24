const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const { requireCustomer } = require('../middleware/customerAuth');

function signCustomerToken(customer) {
  return jwt.sign({ sub: customer.id, type: 'customer' }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// POST /api/customers/signup
router.post('/signup', async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = await Customer.findOne({ email: email.toLowerCase() });
  if (existing) return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });

  const customer = new Customer({ name, email, phone: phone || '' });
  await customer.setPassword(password);
  await customer.save();

  const token = signCustomerToken(customer);
  res.status(201).json({ token, customer });
});

// POST /api/customers/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const customer = await Customer.findOne({ email: email.toLowerCase(), status: 'active' });
  if (!customer) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await customer.checkPassword(password);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const token = signCustomerToken(customer);
  res.json({ token, customer });
});

// GET /api/customers/me
router.get('/me', requireCustomer, (req, res) => res.json(req.customer));

// PUT /api/customers/me — update profile / addresses
router.put('/me', requireCustomer, async (req, res) => {
  const { name, phone, addresses } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (phone !== undefined) updates.phone = phone;
  if (addresses !== undefined) updates.addresses = addresses;

  const customer = await Customer.findByIdAndUpdate(req.customer.id, updates, { new: true, runValidators: true });
  res.json(customer);
});

// GET /api/customers/me/orders — this customer's own order history
router.get('/me/orders', requireCustomer, async (req, res) => {
  const orders = await Order.find({ customerId: req.customer.id }).sort({ createdAt: -1 });
  res.json(orders);
});

module.exports = router;
