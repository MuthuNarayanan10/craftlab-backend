const jwt = require('jsonwebtoken');
const Customer = require('../models/Customer');

/** Verifies a customer's Bearer token → req.customer. Admin tokens are rejected (separate `type` claim). */
async function requireCustomer(req, res, next) {
  try {
    const header = req.header('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please log in to continue' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== 'customer') return res.status(401).json({ error: 'Invalid token type' });
    const customer = await Customer.findById(payload.sub);
    if (!customer || customer.status !== 'active') return res.status(401).json({ error: 'Invalid or blocked account' });
    req.customer = customer;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

/** Like requireCustomer but never fails — sets req.customer when a valid token is present (used by checkout). */
async function optionalCustomer(req, res, next) {
  try {
    const header = req.header('Authorization') || '';
    if (header.startsWith('Bearer ')) {
      const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      if (payload.type === 'customer') { const c = await Customer.findById(payload.sub); if (c && c.status === 'active') req.customer = c; }
    }
  } catch (e) { /* invalid token → treated as guest */ }
  next();
}
module.exports = { requireCustomer, optionalCustomer };
