const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const Admin = require('../models/Admin');
const { logAction } = require('../models/AuditLog');
const { requireAdmin } = require('../middleware/adminAuth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const admin = await Admin.findOne({ email: email.toLowerCase(), active: true });
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await admin.checkPassword(password);
  if (!valid) {
    await logAction('admin.login_failed', email);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ sub: admin.id, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
  await logAction('admin.login', admin.email);
  res.json({ token, admin });
});

// GET /api/auth/me — confirms the current token is valid and returns the admin
router.get('/me', requireAdmin, (req, res) => {
  res.json(req.admin);
});

module.exports = router;
