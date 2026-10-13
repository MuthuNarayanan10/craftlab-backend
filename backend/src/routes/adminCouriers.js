const express = require('express');
const router = express.Router();
const CourierPartner = require('../models/CourierPartner');
const { audit } = require('../models/AuditLog');
const okUrl = (u) => !u || /^https?:\/\/[^\s"'<>]+$/.test(u);
const clean = (b) => ({ name: String(b.name || '').trim().slice(0, 60), trackUrl: String(b.trackUrl || '').trim().slice(0, 400), active: b.active !== false });

// GET /api/admin/couriers — the dropdown list (admin + staff)
router.get('/', async (req, res) => { await CourierPartner.ensureDefaults(); res.json({ couriers: await CourierPartner.find().sort({ sort: 1, name: 1 }) }); });
router.post('/', async (req, res) => {
  const d = clean(req.body); if (!d.name) return res.status(400).json({ error: 'Enter the courier name' });
  if (!okUrl(d.trackUrl)) return res.status(400).json({ error: 'The tracking page link must start with https://' });
  if (await CourierPartner.findOne({ name: new RegExp('^' + d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') })) return res.status(409).json({ error: 'That courier is already in the list' });
  const c = await CourierPartner.create({ ...d, sort: await CourierPartner.countDocuments() });
  await audit({ action: 'courier.created', actor: req.admin.email, entity: 'courier', entityId: c.id, summary: `Courier added: ${c.name}`, req }); res.status(201).json(c);
});
router.put('/:id', async (req, res) => {
  const d = clean(req.body); if (!d.name) return res.status(400).json({ error: 'Enter the courier name' });
  if (!okUrl(d.trackUrl)) return res.status(400).json({ error: 'The tracking page link must start with https://' });
  const c = await CourierPartner.findByIdAndUpdate(req.params.id, d, { new: true }); if (!c) return res.status(404).json({ error: 'Not found' });
  await audit({ action: 'courier.updated', actor: req.admin.email, entity: 'courier', entityId: c.id, summary: `Courier updated: ${c.name}`, req }); res.json(c);
});
// Orders keep the courier name they were given, so removing one never breaks an old order.
router.delete('/:id', async (req, res) => {
  const c = await CourierPartner.findByIdAndDelete(req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  await audit({ action: 'courier.deleted', actor: req.admin.email, entity: 'courier', entityId: c.id, summary: `Courier removed: ${c.name}`, req }); res.json({ ok: true });
});
module.exports = router;
