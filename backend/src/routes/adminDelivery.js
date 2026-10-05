const express = require('express');
const router = express.Router();
const DeliveryMethod = require('../models/DeliveryMethod');
const { requireRole } = require('../middleware/adminAuth');
const { audit } = require('../models/AuditLog');

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => String(x).replace(/\D/g, '')).filter(Boolean);
const num = (v, max = 100000) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };

function read(body, current = {}) {
  const out = {}, errors = [];
  if (body.name !== undefined) { const n = String(body.name).trim(); if (!n) errors.push('Give the method a name'); out.name = n.slice(0, 60); }
  if (body.description !== undefined) out.description = String(body.description).trim().slice(0, 200);
  if (body.type !== undefined) { if (!['courier', 'manual'].includes(body.type)) errors.push('Type must be courier or manual'); out.type = body.type; }
  for (const [k, max] of [['fee', 100000], ['freeAbove', 10000000], ['etaMinDays', 60], ['etaMaxDays', 60], ['sortOrder', 1000]]) if (body[k] !== undefined) { const n = num(body[k], max); if (n === null) errors.push(`${k} must be a number between 0 and ${max}`); else out[k] = n; }
  const min = out.etaMinDays ?? current.etaMinDays ?? 0, maxd = out.etaMaxDays ?? current.etaMaxDays ?? 0;
  if (min > maxd) errors.push('The minimum delivery days can’t be more than the maximum');
  if (body.enabled !== undefined) out.enabled = !!body.enabled;
  if (body.codAllowed !== undefined) out.codAllowed = !!body.codAllowed;
  if (body.courierProvider !== undefined) { if (!['', 'shiprocket'].includes(body.courierProvider)) errors.push('Unknown courier provider'); out.courierProvider = body.courierProvider; }
  if (body.pincodes !== undefined) { out.pincodes = [...new Set(asList(body.pincodes))]; if (out.pincodes.some((p) => p.length !== 6)) errors.push('Each PIN code must be 6 digits'); }
  if (body.pincodePrefixes !== undefined) { out.pincodePrefixes = [...new Set(asList(body.pincodePrefixes))]; if (out.pincodePrefixes.some((p) => p.length < 1 || p.length > 5)) errors.push('A PIN prefix must be 1–5 digits (e.g. 600)'); }
  return { out, errors };
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

router.get('/', async (req, res) => res.json(await DeliveryMethod.listAll()));

// POST /api/admin/delivery — add your own method (owner only)
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const { out, errors } = read(req.body);
  if (!out.name) errors.push('Give the method a name');
  if (errors.length) return res.status(400).json({ error: errors[0] });
  await DeliveryMethod.ensureDefaults();
  let key = slug(req.body.key || out.name) || 'method', n = 1;
  while (await DeliveryMethod.findOne({ key })) key = `${slug(out.name)}-${++n}`.slice(0, 30);
  const m = await DeliveryMethod.create({ ...out, key, enabled: !!out.enabled, sortOrder: out.sortOrder ?? (await DeliveryMethod.countDocuments({})) + 1 });
  await audit({ action: 'delivery.created', actor: req.admin.email, entity: 'delivery_method', entityId: m.key, summary: `Added delivery method “${m.name}”`, after: m.toJSON(), req });
  res.status(201).json(m);
});

// PUT /api/admin/delivery/:key — edit / switch on or off (owner only). At least one method must stay enabled.
router.put('/:key', requireRole('ADMIN'), async (req, res) => {
  await DeliveryMethod.ensureDefaults();
  const m = await DeliveryMethod.findOne({ key: req.params.key });
  if (!m) return res.status(404).json({ error: 'Delivery method not found' });
  const { out, errors } = read(req.body, m);
  if (errors.length) return res.status(400).json({ error: errors[0] });
  if (out.enabled === false && m.enabled && (await DeliveryMethod.countDocuments({ enabled: true, key: { $ne: m.key } })) === 0) return res.status(400).json({ error: 'Keep at least one delivery method switched on — otherwise customers can’t check out.' });
  const before = m.toJSON();
  Object.assign(m, out); await m.save();
  await audit({ action: 'delivery.updated', actor: req.admin.email, entity: 'delivery_method', entityId: m.key, summary: `${m.name}: ${out.enabled === true && !before.enabled ? 'switched ON' : out.enabled === false && before.enabled ? 'switched OFF' : 'updated'}`, before, after: m.toJSON(), req });
  res.json(m);
});

router.delete('/:key', requireRole('ADMIN'), async (req, res) => {
  const m = await DeliveryMethod.findOne({ key: req.params.key });
  if (!m) return res.status(404).json({ error: 'Delivery method not found' });
  if (m.isDefault) return res.status(400).json({ error: 'Built-in methods can’t be deleted — switch them off instead.' });
  if (m.enabled && (await DeliveryMethod.countDocuments({ enabled: true, key: { $ne: m.key } })) === 0) return res.status(400).json({ error: 'Keep at least one delivery method switched on.' });
  await m.deleteOne();
  await audit({ action: 'delivery.deleted', actor: req.admin.email, entity: 'delivery_method', entityId: m.key, summary: `Deleted delivery method “${m.name}”`, req });
  res.json({ deleted: true });
});
module.exports = router;
