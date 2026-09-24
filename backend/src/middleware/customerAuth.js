const jwt = require('jsonwebtoken');
const Customer = require('../models/Customer');

/** Verifies a customer's Bearer token and attaches req.customer.
 *  Separate secret namespace from admin tokens (different `type` claim)
 *  so a customer token can never be used to access admin routes. */
async function requireCustomer(req, res, next) {
  try {
    const header = req.header('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== 'customer') return res.status(401).json({ error: 'Invalid token type' });

    const customer = await Customer.findById(payload.sub);
    if (!customer || customer.status !== 'active') return res.status(401).json({ error: 'Invalid or blocked account' });

    req.customer = customer;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireCustomer };
