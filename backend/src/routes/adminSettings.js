const express = require('express');
const router = express.Router();
const { getSettings } = require('../models/Settings');
const { requireRole } = require('../middleware/adminAuth');
const { resetNotifierCache } = require('../services/notifier');
const { audit } = require('../models/AuditLog');

const TEXT = ['businessName', 'legalName', 'gstin', 'pan', 'address', 'city', 'state', 'pincode', 'phone', 'email', 'invoicePrefix', 'supportWhatsapp'];
const NUM = { defaultTaxRate: [0, 100], codFee: [0, 10000], prepaidDiscountPercent: [0, 50], returnWindowDays: [0, 60] };
const BOOL = ['codEnabled', 'customerLoginEnabled', 'customerSignupEnabled', 'otpEnabled', 'guestCheckoutEnabled', 'autoCreateAccounts', 'requireMobileVerification', 'autoCreateShipment', 'notifyEmailEnabled', 'notifyWhatsappEnabled', 'autoApproveReturns'];
const ENUM = { otpProvider: ['none', 'dev', 'msg91', 'firebase'], defaultCourierProvider: ['manual', 'shiprocket'] };

router.get('/', async (req, res) => res.json(await getSettings()));

// PUT /api/admin/settings — owner only; every change is audited with before/after
router.put('/', requireRole('ADMIN'), async (req, res) => {
  const s = await getSettings();
  const before = s.toObject();
  for (const k of TEXT) if (req.body[k] !== undefined) s[k] = String(req.body[k]).trim().slice(0, 200);
  for (const [k, [min, max]] of Object.entries(NUM)) {
    if (req.body[k] === undefined) continue;
    const n = Number(req.body[k]);
    if (!Number.isFinite(n) || n < min || n > max) return res.status(400).json({ error: `${k} must be between ${min} and ${max}` });
    s[k] = n;
  }
  for (const k of BOOL) if (req.body[k] !== undefined) s[k] = !!req.body[k];
  for (const [k, allowed] of Object.entries(ENUM)) if (req.body[k] !== undefined) { if (!allowed.includes(req.body[k])) return res.status(400).json({ error: `Invalid ${k}` }); s[k] = req.body[k]; }
  if (s.supportWhatsapp) s.supportWhatsapp = s.supportWhatsapp.replace(/\D/g, '');
  if (s.otpProvider === 'dev' && process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_OTP !== 'true') return res.status(400).json({ error: 'The “dev” OTP provider can’t be used in production. Choose MSG91 or Firebase.' });
  if (!s.customerLoginEnabled && !s.guestCheckoutEnabled && !s.requireMobileVerification) return res.status(400).json({ error: 'Customers must be able to buy: keep Login or Guest checkout switched on.' });
  await s.save();
  resetNotifierCache();
  const after = s.toObject();
  const changed = Object.keys(after).filter((k) => !['updatedAt', '__v'].includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changed.length) await audit({ action: 'settings.updated', actor: req.admin.email, entity: 'settings', summary: `Settings changed: ${changed.join(', ')}`, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])), req });
  res.json(s);
});
module.exports = router;
