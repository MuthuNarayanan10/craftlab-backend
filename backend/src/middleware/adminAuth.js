const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');

/** Verifies the admin Bearer token and attaches req.admin. Customer tokens (type: 'customer') are rejected. */
async function requireAdmin(req, res, next) {
  try {
    const header = req.header('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type === 'customer') return res.status(403).json({ error: 'Not allowed' });
    const admin = await Admin.findById(payload.sub);
    if (!admin || !admin.active) return res.status(401).json({ error: 'Invalid or inactive admin' });
    req.admin = admin;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Restricts a route to the given role(s). ADMIN can do everything; STAFF is limited to day-to-day operations. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin || !roles.includes(req.admin.role)) return res.status(403).json({ error: 'Only the store owner (ADMIN role) can do this' });
    next();
  };
}
module.exports = { requireAdmin, requireRole };
