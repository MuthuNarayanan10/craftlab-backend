const express = require('express');
const router = express.Router();
const { getSettings } = require('../models/Settings');
const { logAction } = require('../models/AuditLog');

const TEXT = ['businessName', 'legalName', 'gstin', 'pan', 'address', 'city', 'state', 'pincode', 'phone', 'email', 'invoicePrefix', 'supportWhatsapp'];
const NUM = { defaultTaxRate: [0, 100], codFee: [0, 10000], prepaidDiscountPercent: [0, 50], returnWindowDays: [0, 60] };

// GET /api/admin/settings
router.get('/', async (req, res) => res.json(await getSettings()));

// PUT /api/admin/settings
router.put('/', async (req, res) => {
  const s = await getSettings();
  for (const k of TEXT) if (req.body[k] !== undefined) s[k] = String(req.body[k]).trim();
  for (const [k, [min, max]] of Object.entries(NUM)) {
    if (req.body[k] === undefined) continue;
    const n = Number(req.body[k]);
    if (!Number.isFinite(n) || n < min || n > max) return res.status(400).json({ error: `${k} must be between ${min} and ${max}` });
    s[k] = n;
  }
  if (req.body.codEnabled !== undefined) s.codEnabled = !!req.body.codEnabled;
  if (s.supportWhatsapp) s.supportWhatsapp = s.supportWhatsapp.replace(/\D/g, ''); // digits only, with country code
  await s.save();
  await logAction('settings.updated', req.admin.email, {});
  res.json(s);
});

module.exports = router;
