const express = require('express');
const router = express.Router();
const Pincode = require('../models/Pincode');
const { getSettings } = require('../models/Settings');
const { requireRole } = require('../middleware/adminAuth');
const { parsePincodeCsv, validPin, normalizePin } = require('../utils/pincode');
const { audit } = require('../models/AuditLog');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/admin/pincodes?q=&state=&status=&page=
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = 30, f = {};
  const q = String(req.query.q || '').trim();
  if (/^\d{1,6}$/.test(q)) f.pincode = new RegExp('^' + q); else if (q) f.$or = [{ city: new RegExp(esc(q), 'i') }, { state: new RegExp(esc(q), 'i') }];
  if (req.query.state) f.state = String(req.query.state);
  if (req.query.status === 'serviceable') f.serviceable = true; if (req.query.status === 'blocked') f.serviceable = false;
  const [rows, total, svc, blocked, settings] = await Promise.all([Pincode.find(f).sort({ pincode: 1 }).skip((page - 1) * limit).limit(limit), Pincode.countDocuments(f), Pincode.countDocuments({ serviceable: true }), Pincode.countDocuments({ serviceable: false }), getSettings()]);
  res.json({ pincodes: rows.map((r) => r.toJSON()), total, page, pages: Math.ceil(total / limit) || 1, stats: { serviceable: svc, blocked }, mode: settings.pincodeCheckMode });
});

// PUT /api/admin/pincodes/:pin — add or change one PIN
router.put('/:pin', async (req, res) => {
  const pin = normalizePin(req.params.pin); if (!validPin(pin)) return res.status(400).json({ error: 'Enter a valid 6-digit PIN code' });
  const b = req.body, set = {};
  if (b.city !== undefined) set.city = String(b.city).trim().slice(0, 80); if (b.state !== undefined) set.state = String(b.state).trim().slice(0, 80); if (b.note !== undefined) set.note = String(b.note).slice(0, 120);
  if (b.serviceable !== undefined) set.serviceable = !!b.serviceable; if (b.codAvailable !== undefined) set.codAvailable = !!b.codAvailable;
  if (b.etaDays !== undefined) { const n = Number(b.etaDays); if (!Number.isInteger(n) || n < 0 || n > 60) return res.status(400).json({ error: 'Delivery days must be a whole number from 0 to 60' }); set.etaDays = n; }
  const doc = await Pincode.findOneAndUpdate({ pincode: pin }, { $set: set, $setOnInsert: { pincode: pin } }, { new: true, upsert: true });
  await audit({ action: 'pincode.saved', actor: req.admin.email, entity: 'pincode', entityId: pin, summary: `PIN ${pin} ${doc.serviceable ? 'serviceable' : 'NOT serviceable'}${doc.codAvailable ? '' : ', no COD'}`, req });
  res.json(doc.toJSON());
});

router.delete('/:pin', requireRole('ADMIN'), async (req, res) => {
  const r = await Pincode.deleteOne({ pincode: normalizePin(req.params.pin) }); if (!r.deletedCount) return res.status(404).json({ error: 'PIN code not found' });
  await audit({ action: 'pincode.deleted', actor: req.admin.email, entity: 'pincode', entityId: req.params.pin, summary: `Removed PIN ${req.params.pin}`, req }); res.json({ deleted: true });
});

// POST /api/admin/pincodes/import {csv, replace?} — owner only. Upserts every row; `replace` first clears the registry.
router.post('/import', requireRole('ADMIN'), async (req, res) => {
  const { rows, errors } = parsePincodeCsv(req.body.csv);
  if (!rows.length) return res.status(400).json({ error: errors[0] || 'No valid rows found', errors });
  if (req.body.replace) await Pincode.deleteMany({});
  for (let i = 0; i < rows.length; i += 1000) {
    await Pincode.bulkWrite(rows.slice(i, i + 1000).map((r) => ({ updateOne: { filter: { pincode: r.pincode }, update: { $set: { city: r.city, state: r.state, serviceable: r.serviceable, codAvailable: r.codAvailable, etaDays: r.etaDays }, $setOnInsert: { pincode: r.pincode } }, upsert: true } })));
  }
  await audit({ action: 'pincode.imported', actor: req.admin.email, entity: 'pincode', summary: `Imported ${rows.length} PIN codes${req.body.replace ? ' (replaced the list)' : ''}`, meta: { skipped: errors.length }, req });
  res.json({ imported: rows.length, skipped: errors.length, errors });
});
module.exports = router;
