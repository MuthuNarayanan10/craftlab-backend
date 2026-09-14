const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');

/** Verifies the Bearer token on admin routes and attaches req.admin. */
async function requireAdmin(req, res, next) {
  try {
    const header = req.header('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await Admin.findById(payload.sub);
    if (!admin || !admin.active) return res.status(401).json({ error: 'Invalid or inactive admin' });

    req.admin = admin;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Restricts a route to ADMIN role only (STAFF is blocked). */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.admin || req.admin.role !== role) {
      return res.status(403).json({ error: `Requires ${role} role` });
    }
    next();
  };
}

module.exports = { requireAdmin, requireRole };
