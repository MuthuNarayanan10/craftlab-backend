const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const { requireCustomer } = require('../middleware/customerAuth');
const { verifyFirebaseToken } = require('../utils/firebase');

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

// POST /api/customers/otp-login — body: { idToken, name? }
// idToken comes from Firebase Phone Auth on the frontend after the customer
// enters their mobile number and the 6-digit SMS OTP. We verify it server-side
// (never trust a phone number sent raw from the browser), then find-or-create
// the customer account by phone number and issue our own JWT, same as the
// password-login flow — so every other route (orders, addresses) works
// identically regardless of which way the customer logged in.
router.post('/otp-login', async (req, res) => {
  const { idToken, name } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken is required' });

  let decoded;
  try {
    decoded = await verifyFirebaseToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired OTP session. Please try again.' });
  }

  const phone = decoded.phone_number; // E.164 format, e.g. +919876543210
  if (!phone) return res.status(400).json({ error: 'No verified phone number on this token' });

  let customer = await Customer.findOne({ phone });
  if (!customer) {
    customer = await Customer.create({
      name: name || 'Craft Lab Customer',
      phone,
      firebaseUid: decoded.uid,
      authMethod: 'otp',
    });
  } else if (customer.status === 'blocked') {
    return res.status(403).json({ error: 'This account has been blocked. Contact care@thecraftlab.co.in.' });
  } else if (!customer.firebaseUid) {
    customer.firebaseUid = decoded.uid; // link if this phone previously signed up another way
    await customer.save();
  }

  const token = signCustomerToken(customer);
  res.json({ token, customer, isNewCustomer: customer.createdAt.getTime() === customer.updatedAt.getTime() });
});

// GET /api/customers/me
router.get('/me', requireCustomer, (req, res) => res.json(req.customer));

// PUT /api/customers/me — update profile / saved addresses
router.put('/me', requireCustomer, async (req, res) => {
  const { name, phone, email, addresses } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = String(name).trim();
  if (phone !== undefined && !req.customer.phone) updates.phone = phone; // phone of an OTP account is verified and can't be changed here
  if (email !== undefined && String(email).toLowerCase() !== req.customer.email) {
    const clash = await Customer.findOne({ email: String(email).toLowerCase(), _id: { $ne: req.customer.id } });
    if (clash) return res.status(409).json({ error: 'That email is already used by another account' });
    updates.email = String(email).toLowerCase();
  }
  if (addresses !== undefined) {
    if (!Array.isArray(addresses) || addresses.length > 10) return res.status(400).json({ error: 'You can save up to 10 addresses' });
    updates.addresses = addresses;
  }
  const customer = await Customer.findByIdAndUpdate(req.customer.id, updates, { new: true, runValidators: true });
  res.json(customer);
});

// GET /api/customers/me/orders — this customer's own order history
router.get('/me/orders', requireCustomer, async (req, res) => {
  const orders = await Order.find({ customerId: req.customer.id }).sort({ createdAt: -1 });
  res.json(orders);
});

module.exports = router;
