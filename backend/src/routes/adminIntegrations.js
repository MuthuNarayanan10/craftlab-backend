const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Integration = require('../models/Integration');
const { getSettings } = require('../models/Settings');
const { requireRole } = require('../middleware/adminAuth');
const { listCouriers, getCourier } = require('../utils/courier');
const { envStatus, courierFromEnv, webhookTokenFor } = require('../utils/courier/env');
const { load: loadCourier } = require('../services/shipmentService');
const { isEmailConfigured, emailProviderName, getLastEmailError, sendEmail } = require('../utils/email');
const { devSender, msg91Sender, brevoSender, zeptomailSender } = require('../utils/otp/senders');
const { isConfigured } = require('../utils/crypto');
const { resetNotifierCache } = require('../services/notifier');
const { audit } = require('../models/AuditLog');

// What can be configured, and which fields each provider needs. Secrets are write-only: the API never returns them.
const CATALOG = {
  shiprocket: { kind: 'courier', label: 'Shiprocket', secrets: ['email', 'password'], config: ['pickupLocation', 'defaultWeightKg', 'defaultLengthCm', 'defaultBreadthCm', 'defaultHeightCm'], help: 'Use an API user created in Shiprocket (Settings → API). “Pickup location” must match the pickup nickname in your Shiprocket account.' },
  delhivery: { kind: 'courier', label: 'Delhivery (direct)', secrets: ['apiToken'], config: ['pickupLocation', 'defaultWeightKg', 'defaultLengthCm', 'defaultBreadthCm', 'defaultHeightCm'], help: 'Direct Delhivery B2C account: API token from Delhivery One, plus a pickup location (warehouse) registered under the same name. Best once you ship in volume; for a few orders a day an aggregator is usually cheaper.' },
  msg91: { kind: 'otp', label: 'MSG91 (SMS OTP)', secrets: ['authKey'], config: ['templateId'], help: 'Needs a DLT-approved OTP template in MSG91 (mandatory for SMS in India).' },
  brevo: { kind: 'otp', label: 'Brevo (email OTP — free: 300 emails/day)', secrets: ['apiKey'], config: ['senderEmail', 'senderName'], help: 'Create a free Brevo account, verify your sender email/domain (Senders & IP), and create an API key (SMTP & API → API Keys). Then choose “Brevo” as the OTP provider in Settings.' },
  zeptomail: { kind: 'otp', label: 'Zoho ZeptoMail (email OTP — first 10,000 emails free)', secrets: ['sendMailToken'], config: ['senderEmail', 'senderName', 'region'], help: 'Create a Mail Agent in ZeptoMail, verify your sending domain, copy its “Send Mail token”. Region = in, com or eu — the data centre where your ZeptoMail account lives. Then choose “Zoho ZeptoMail” as the OTP provider in Settings.' },
  whatsapp_cloud: { kind: 'whatsapp', label: 'WhatsApp Business Cloud API', secrets: ['accessToken'], config: ['phoneNumberId', 'templateName', 'languageCode'], help: 'Needs a Meta Business account, a verified WhatsApp number and an approved message template with 3 variables ({{1}} name, {{2}} order number, {{3}} message).' },
};

const { brevoFromEnv } = require('../utils/otp/brevoEnv');
const { msg91FromEnv } = require('../utils/otp/msg91Env');

// Email-OTP status (set through BREVO_* environment variables) and a one-click test that sends ONE real code
router.get('/otp-env', (req, res) => { const e = brevoFromEnv(); res.json({ configured: !!e, senderEmail: e ? e.senderEmail : '', missing: [!process.env.BREVO_API_KEY && 'BREVO_API_KEY', !process.env.BREVO_SENDER_EMAIL && 'BREVO_SENDER_EMAIL'].filter(Boolean) }); });
router.post('/otp-env/test', requireRole('ADMIN'), async (req, res) => {
  const e = brevoFromEnv(); if (!e) return res.status(400).json({ error: 'Add BREVO_API_KEY and BREVO_SENDER_EMAIL as environment variables first, then redeploy' });
  const to = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return res.status(400).json({ error: 'Enter an email address to send ONE test code to' });
  try { await brevoSender({ ...e, senderName: e.senderName || (await getSettings()).businessName, baseUrl: process.env.BREVO_BASE_URL || undefined }).send(to, String(Math.floor(100000 + Math.random() * 900000))); res.json({ ok: true, message: `Test code emailed to ${to}` }); }
  catch (err) { res.json({ ok: false, message: String(err.message).slice(0, 300) }); }
});

const envCouriersView = (req) => {
  const host = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  return Object.fromEntries(['shiprocket', 'delhivery'].map((id) => { const st = envStatus(id); const tok = st.configured ? webhookTokenFor(id) : ''; return [id, { ...st, webhookUrl: tok ? `${host}/api/webhooks/courier/${id}?token=${tok}` : '' }]; }));
};

// Courier connection test for couriers configured by environment variables
router.post('/env/:provider/test', requireRole('ADMIN'), async (req, res) => {
  const id = req.params.provider; const e = courierFromEnv(id);
  if (!e) return res.status(400).json({ ok: false, message: `${id} is not configured by environment variables yet (${envStatus(id)?.missing.join(', ') || 'unknown provider'})` });
  try { res.json(await getCourier(id).testConnection(e.creds)); } catch (err) { res.json({ ok: false, message: String(err.message).slice(0, 300) }); }
});

// Email health: provider in use, the last failure (kept in memory), and a one-click test mail
router.get('/email-status', (req, res) => res.json({ configured: isEmailConfigured(), provider: emailProviderName(), senderEmail: (brevoFromEnv() || {}).senderEmail || '', missing: [!process.env.BREVO_API_KEY && 'BREVO_API_KEY', !process.env.BREVO_SENDER_EMAIL && 'BREVO_SENDER_EMAIL'].filter(Boolean), lastError: getLastEmailError() }));
router.post('/email-test', requireRole('ADMIN'), async (req, res) => {
  const to = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return res.status(400).json({ error: 'Enter an email address to send ONE test email to' });
  const r = await sendEmail(to, 'Test email from The Craft Lab', '<p>If you can read this, order and support emails will reach customers and you.</p>');
  res.json(r.error ? { ok: false, message: r.error } : r.skipped ? { ok: false, message: 'Email is not configured (set BREVO_API_KEY and BREVO_SENDER_EMAIL)' } : { ok: true, message: `Test email sent to ${to}` });
});

// Mobile (SMS) OTP status — MSG91_AUTH_KEY + MSG91_TEMPLATE_ID — and a one-click test that sends ONE real SMS
router.get('/sms-env', (req, res) => { const e = msg91FromEnv(); res.json({ configured: !!e, missing: [!process.env.MSG91_AUTH_KEY && 'MSG91_AUTH_KEY', !process.env.MSG91_TEMPLATE_ID && 'MSG91_TEMPLATE_ID'].filter(Boolean) }); });
router.post('/sms-env/test', requireRole('ADMIN'), async (req, res) => {
  const e = msg91FromEnv(); if (!e) return res.status(400).json({ error: 'Add MSG91_AUTH_KEY and MSG91_TEMPLATE_ID as environment variables first, then redeploy' });
  const digits = String(req.body.phone || '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(digits)) return res.status(400).json({ error: 'Enter a 10-digit mobile number to send ONE test SMS to' });
  try { await msg91Sender({ ...e, baseUrl: process.env.MSG91_BASE_URL || undefined }).send('+91' + digits, String(Math.floor(100000 + Math.random() * 900000))); res.json({ ok: true, message: `Test OTP sent to +91 ${digits}` }); }
  catch (err) { res.json({ ok: false, message: String(err.message).slice(0, 300) }); }
});

router.get('/', async (req, res) => {
  const saved = await Integration.find();
  const settings = await getSettings();
  res.json({
    secretsStorageReady: isConfigured(),
    selected: { courier: settings.defaultCourierProvider, otp: settings.otpProvider },
    couriers: listCouriers(),
    envCouriers: envCouriersView(req),
    providers: Object.entries(CATALOG).map(([id, c]) => ({ id, ...c, saved: (saved.find((s) => s.provider === id) || { toPublic: () => null }).toPublic() })),
  });
});

// PUT /api/admin/integrations/:provider — owner only. Blank secret fields keep the existing secret.
router.put('/:provider', requireRole('ADMIN'), async (req, res) => {
  const def = CATALOG[req.params.provider];
  if (!def) return res.status(404).json({ error: 'Unknown integration' });
  let doc = await Integration.findOne({ provider: req.params.provider });
  if (!doc) doc = new Integration({ provider: req.params.provider, kind: def.kind });
  const before = { enabled: doc.enabled, config: doc.config };

  const config = {}; for (const k of def.config) if (req.body.config?.[k] !== undefined) config[k] = String(req.body.config[k]).trim().slice(0, 120);
  doc.config = { ...(doc.config || {}), ...config }; doc.markModified('config');
  const provided = {}; for (const k of def.secrets) if (req.body.secrets?.[k]) provided[k] = String(req.body.secrets[k]);
  try { if (Object.keys(provided).length) doc.setSecrets(provided); } catch (e) { return res.status(400).json({ error: e.message }); }
  doc.enabled = !!req.body.enabled;
  if (doc.enabled && !doc.secretsEnc) return res.status(400).json({ error: 'Add the API credentials before enabling this integration' });
  if (!doc.webhookToken) doc.webhookToken = crypto.randomBytes(18).toString('hex');
  doc.updatedBy = req.admin.email;
  await doc.save();
  resetNotifierCache();
  await audit({ action: 'integration.updated', actor: req.admin.email, entity: 'integration', entityId: doc.provider, summary: `${def.label} ${doc.enabled ? 'enabled' : 'disabled'}${Object.keys(provided).length ? ' (credentials changed)' : ''}`, before, after: { enabled: doc.enabled, config: doc.config }, req });
  res.json(doc.toPublic());
});

// POST /api/admin/integrations/:provider/test — verifies the saved credentials really work
router.post('/:provider/test', requireRole('ADMIN'), async (req, res) => {
  const doc = await Integration.findOne({ provider: req.params.provider });
  if (!doc || !doc.secretsEnc) return res.status(400).json({ error: 'Save the credentials first' });
  let result;
  try {
    const s = doc.getSecrets();
    if (doc.provider === 'shiprocket') result = await getCourier('shiprocket').testConnection(s);
    else if (doc.provider === 'whatsapp_cloud') {
      const r = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(doc.config.phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${s.accessToken}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || `WhatsApp API returned ${r.status}`);
      result = { ok: true, message: `Connected to ${j.verified_name || 'WhatsApp'} (${j.display_phone_number || ''})` };
    } else if (doc.provider === 'brevo' || doc.provider === 'zeptomail') {
      const to = String(req.body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return res.status(400).json({ error: 'Enter an email address to send ONE test code to' });
      const c = doc.config || {};
      const sender = doc.provider === 'brevo' ? brevoSender({ apiKey: s.apiKey, senderEmail: c.senderEmail, senderName: c.senderName, baseUrl: process.env.BREVO_BASE_URL || undefined }) : zeptomailSender({ sendMailToken: s.sendMailToken, senderEmail: c.senderEmail, senderName: c.senderName, region: c.region || 'in', baseUrl: process.env.ZEPTOMAIL_BASE_URL || undefined });
      await sender.send(to, String(Math.floor(100000 + Math.random() * 900000)));
      result = { ok: true, message: `Test code emailed to ${to}` };
    } else if (doc.provider === 'msg91') {
      if (!req.body.phone) return res.status(400).json({ error: 'Enter a mobile number to send a test OTP to (this sends one real SMS)' });
      const phone = '+91' + String(req.body.phone).replace(/\D/g, '').slice(-10);
      await msg91Sender({ authKey: s.authKey, templateId: doc.config.templateId }).send(phone, String(Math.floor(100000 + Math.random() * 900000)));
      result = { ok: true, message: `Test OTP sent to ${phone}` };
    }
    doc.lastTest = { at: new Date(), ok: true, message: result.message };
  } catch (e) { doc.lastTest = { at: new Date(), ok: false, message: String(e.message).slice(0, 200) }; }
  await doc.save();
  res.json(doc.lastTest);
});

// POST /api/admin/integrations/courier/serviceability {pincode, cod}
router.post('/courier/serviceability', async (req, res) => {
  const settings = await getSettings();
  const id = settings.defaultCourierProvider;
  if (!id || id === 'manual') return res.status(400).json({ error: 'Manual dispatch has no serviceability check. Enable a courier integration first.' });
  if (!settings.pincode) return res.status(400).json({ error: 'Add your pickup PIN code under Business settings first' });
  let c; try { c = await loadCourier(id); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json(await c.adapter.serviceability(c.creds, { pickupPin: settings.pincode, deliveryPin: String(req.body.pincode || ''), cod: !!req.body.cod }));
});

module.exports = router;
