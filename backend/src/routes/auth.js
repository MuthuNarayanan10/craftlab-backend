const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const Admin = require('../models/Admin');
const { audit } = require('../models/AuditLog');
const { requireAdmin } = require('../middleware/adminAuth');
const { checkPasswordStrength } = require('../utils/password');

const MAX_FAILS = 5, LOCK_MS = 15 * 60e3;

// POST /api/auth/login — with per-account lockout on top of the per-IP rate limit
router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const admin = await Admin.findOne({ email, active: true });
  if (admin && admin.lockUntil && admin.lockUntil > new Date()) {
    return res.status(423).json({ error: 'Too many failed attempts. This account is locked for 15 minutes.' });
  }
  const valid = admin ? await admin.checkPassword(password) : false;
  if (!admin || !valid) {
    if (admin) {
      admin.failedLogins += 1;
      if (admin.failedLogins >= MAX_FAILS) { admin.lockUntil = new Date(Date.now() + LOCK_MS); admin.failedLogins = 0; }
      await admin.save();
    }
    await audit({ action: 'admin.login_failed', actor: email, entity: 'admin', summary: `Failed admin login for ${email}`, req });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  admin.failedLogins = 0; admin.lockUntil = null; admin.lastLoginAt = new Date(); await admin.save();
  const token = jwt.sign({ sub: admin.id, role: admin.role, type: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
  await audit({ action: 'admin.login', actor: admin.email, entity: 'admin', entityId: admin.id, summary: `${admin.email} logged in`, req });
  res.json({ token, admin });
});

// PUT /api/auth/password — change your own password (needs the current one)
router.put('/password', requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') return res.status(400).json({ error: 'Enter your current and new password' });
  if (!(await req.admin.checkPassword(currentPassword))) { await audit({ action: 'admin.password_change_failed', actor: req.admin.email, entity: 'admin', entityId: req.admin.id, summary: 'Wrong current password while changing password', req }); return res.status(400).json({ error: 'Your current password is incorrect' }); }
  const problem = checkPasswordStrength(newPassword, req.admin.email);
  if (problem) return res.status(400).json({ error: problem });
  if (newPassword === currentPassword) return res.status(400).json({ error: 'Choose a password different from the current one' });
  await req.admin.setPassword(newPassword); await req.admin.save();
  await audit({ action: 'admin.password_changed', actor: req.admin.email, entity: 'admin', entityId: req.admin.id, summary: `${req.admin.email} changed their password`, req });
  res.json({ changed: true });
});

router.get('/me', requireAdmin, (req, res) => res.json(req.admin));
module.exports = router;
