const express = require('express');
const router = express.Router();
const Admin = require('../models/Admin');
const { requireRole } = require('../middleware/adminAuth');
const { checkPasswordStrength } = require('../utils/password');
const { audit } = require('../models/AuditLog');

router.use(requireRole('ADMIN')); // the whole team area is owner-only

const view = (a) => ({ id: a.id, name: a.name, email: a.email, role: a.role, active: a.active, locked: !!(a.lockUntil && a.lockUntil > new Date()), lastLoginAt: a.lastLoginAt || null, createdAt: a.createdAt });
const activeOwners = () => Admin.countDocuments({ role: 'ADMIN', active: true });

router.get('/', async (req, res) => res.json((await Admin.find().sort({ createdAt: 1 })).map(view)));

// POST /api/admin/team {name, email, role, password}
router.post('/', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60), email = String(req.body.email || '').trim().toLowerCase(), role = req.body.role === 'ADMIN' ? 'ADMIN' : 'STAFF';
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a name and a valid email address' });
  const problem = checkPasswordStrength(req.body.password, email); if (problem) return res.status(400).json({ error: problem });
  if (await Admin.findOne({ email })) return res.status(409).json({ error: 'There is already a team member with that email' });
  const a = new Admin({ name, email, role }); await a.setPassword(req.body.password); await a.save();
  await audit({ action: 'team.created', actor: req.admin.email, entity: 'admin', entityId: a.id, summary: `Added ${role} login for ${email}`, req });
  res.status(201).json(view(a));
});

// PUT /api/admin/team/:id {name?, role?, active?, password?}
router.put('/:id', async (req, res) => {
  const a = await Admin.findById(req.params.id); if (!a) return res.status(404).json({ error: 'Team member not found' });
  const self = String(a.id) === String(req.admin.id), before = { role: a.role, active: a.active }, changes = [];
  if (req.body.name !== undefined) { a.name = String(req.body.name).trim().slice(0, 60) || a.name; }
  if (req.body.role !== undefined && req.body.role !== a.role) {
    if (!['ADMIN', 'STAFF'].includes(req.body.role)) return res.status(400).json({ error: 'Role must be ADMIN or STAFF' });
    if (self) return res.status(400).json({ error: 'You can’t change your own role — ask another owner.' });
    if (a.role === 'ADMIN' && a.active && (await activeOwners()) <= 1) return res.status(400).json({ error: 'Keep at least one active owner (ADMIN).' });
    a.role = req.body.role; changes.push(`role → ${a.role}`);
  }
  if (req.body.active !== undefined && !!req.body.active !== a.active) {
    if (self) return res.status(400).json({ error: 'You can’t switch off your own login.' });
    if (!req.body.active && a.role === 'ADMIN' && (await activeOwners()) <= 1) return res.status(400).json({ error: 'Keep at least one active owner (ADMIN).' });
    a.active = !!req.body.active; changes.push(a.active ? 'enabled' : 'disabled');
  }
  if (req.body.password !== undefined && req.body.password !== '') {
    if (self) return res.status(400).json({ error: 'Change your own password under Settings → My password.' });
    const problem = checkPasswordStrength(req.body.password, a.email); if (problem) return res.status(400).json({ error: problem });
    await a.setPassword(req.body.password); a.failedLogins = 0; a.lockUntil = null; changes.push('password reset');
  }
  if (req.body.unlock) { a.failedLogins = 0; a.lockUntil = null; changes.push('unlocked'); }
  await a.save();
  if (changes.length) await audit({ action: 'team.updated', actor: req.admin.email, entity: 'admin', entityId: a.id, summary: `${a.email}: ${changes.join(', ')}`, before, after: { role: a.role, active: a.active }, req });
  res.json(view(a));
});
module.exports = router;
