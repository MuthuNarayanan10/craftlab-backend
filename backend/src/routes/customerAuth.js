const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Return = require('../models/Return');
const Integration = require('../models/Integration');
const { getSettings } = require('../models/Settings');
const { requireCustomer } = require('../middleware/customerAuth');
const { verifyFirebaseToken } = require('../utils/firebase');
const { createOtpService, OtpError } = require('../utils/otpService');
const { devSender, msg91Sender } = require('../utils/otp/senders');
const otpStore = require('../services/otpStore');
const { buildJourney } = require('../utils/orderStatus');
const { customerJourney, normalize } = require('../utils/returnStatus');
const { audit } = require('../models/AuditLog');
const { logger } = require('../utils/logger');

const signToken = (c) => jwt.sign({ sub: c.id, type: 'customer' }, process.env.JWT_SECRET, { expiresIn: '30d' });
const issueSession = async (customer, extra = {}) => { customer.lastLoginAt = new Date(); await customer.save(); return { token: signToken(customer), customer, ...extra }; };

/** Server-side switches, enforced here — hiding a button in the UI is not security. */
function need(test, message) {
  return async (req, res, next) => { const s = await getSettings(); req.settings = s; return test(s) ? next() : res.status(403).json({ error: message }); };
}

async function buildOtpService(settings) {
  let sender;
  if (settings.otpProvider === 'dev') sender = devSender();
  else if (settings.otpProvider === 'msg91') {
    const i = await Integration.findOne({ provider: 'msg91', enabled: true });
    if (!i) throw new OtpError('NOT_CONFIGURED', 'SMS OTP is not configured yet', 503);
    const s = i.getSecrets(); sender = msg91Sender({ authKey: s.authKey, templateId: i.config.templateId });
  } else throw new OtpError('NOT_CONFIGURED', settings.otpProvider === 'firebase' ? 'This store uses Firebase OTP — use the on-screen login' : 'OTP login is not set up on this store', 503);
  return createOtpService({ store: otpStore, sender, hmacSecret: process.env.OTP_HMAC_SECRET || process.env.JWT_SECRET });
}
function sendError(res, e) {
  if (e instanceof OtpError) return res.status(e.status).json({ error: e.message, code: e.code, retryAfterSec: e.retryAfterSec });
  throw e;
}

/* ---------- what the storefront is allowed to offer ---------- */
router.get('/auth-options', async (req, res) => {
  const s = await getSettings();
  res.json({ loginEnabled: s.customerLoginEnabled, signupEnabled: s.customerSignupEnabled, otpEnabled: s.otpEnabled && s.otpProvider !== 'none', otpProvider: s.otpProvider, guestCheckoutEnabled: s.guestCheckoutEnabled && !s.requireMobileVerification, requireMobileVerification: s.requireMobileVerification });
});

/* ---------- mobile OTP (server-side codes: provider 'msg91' / 'dev') ---------- */
router.post('/otp/send', need((s) => s.otpEnabled && ['dev', 'msg91'].includes(s.otpProvider), 'OTP login is not available right now'), async (req, res) => {
  try {
    const svc = await buildOtpService(req.settings);
    const r = await svc.send(req.body.phone, req.ip);
    res.json({ sent: true, phone: r.phone, expiresInSec: r.expiresInSec, resendAfterSec: r.resendAfterSec, devCode: r.devCode });
  } catch (e) { if (e instanceof OtpError && e.code === 'SEND_FAILED') logger.error('otp_send_failed', { cause: e.cause }); sendError(res, e); }
});

router.post('/otp/verify', need((s) => s.otpEnabled && ['dev', 'msg91'].includes(s.otpProvider), 'OTP login is not available right now'), async (req, res) => {
  try {
    const svc = await buildOtpService(req.settings);
    const { phone } = await svc.verify(req.body.phone, req.body.code);
    const s = req.settings;
    let customer = await Customer.findOne({ phone });
    let isNew = false;
    if (!customer) {
      if (!((s.customerSignupEnabled && s.autoCreateAccounts) || s.requireMobileVerification)) return res.status(403).json({ error: 'New accounts are not being created right now' });
      customer = await Customer.create({ name: String(req.body.name || '').trim() || 'Craft Lab Customer', phone, authMethod: 'otp', phoneVerified: true });
      isNew = true;
      await audit({ action: 'customer.created', actor: 'customer', entity: 'customer', entityId: customer.id, summary: `New customer via OTP ${phone}`, req });
    } else {
      if (customer.status === 'blocked') return res.status(403).json({ error: 'This account has been blocked. Contact care@thecraftlab.co.in.' });
      if (!(s.customerLoginEnabled || s.requireMobileVerification)) return res.status(403).json({ error: 'Customer login is currently disabled' });
      customer.phoneVerified = true;
    }
    res.json(await issueSession(customer, { isNewCustomer: isNew }));
  } catch (e) { sendError(res, e); }
});

/* ---------- Firebase phone auth (optional alternative provider) ---------- */
router.post('/otp-login', need((s) => s.otpEnabled && s.otpProvider === 'firebase', 'Firebase OTP login is not enabled'), async (req, res) => {
  const { idToken, name } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken is required' });
  let decoded;
  try { decoded = await verifyFirebaseToken(idToken); } catch (err) { return res.status(401).json({ error: 'Invalid or expired OTP session. Please try again.' }); }
  const phone = decoded.phone_number;
  if (!phone) return res.status(400).json({ error: 'No verified phone number on this token' });
  const s = req.settings;
  let customer = await Customer.findOne({ phone }); let isNew = false;
  if (!customer) {
    if (!((s.customerSignupEnabled && s.autoCreateAccounts) || s.requireMobileVerification)) return res.status(403).json({ error: 'New accounts are not being created right now' });
    customer = await Customer.create({ name: name || 'Craft Lab Customer', phone, firebaseUid: decoded.uid, authMethod: 'otp', phoneVerified: true }); isNew = true;
  } else {
    if (customer.status === 'blocked') return res.status(403).json({ error: 'This account has been blocked.' });
    if (!(s.customerLoginEnabled || s.requireMobileVerification)) return res.status(403).json({ error: 'Customer login is currently disabled' });
    if (!customer.firebaseUid) customer.firebaseUid = decoded.uid;
    customer.phoneVerified = true;
  }
  res.json(await issueSession(customer, { isNewCustomer: isNew }));
});

/* ---------- email + password (optional) ---------- */
router.post('/signup', need((s) => s.customerSignupEnabled, 'Sign-up is currently disabled'), async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (await Customer.findOne({ email: String(email).toLowerCase() })) return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
  const customer = new Customer({ name: String(name).trim(), email, phone: phone || undefined });
  await customer.setPassword(password);
  await customer.save();
  res.status(201).json(await issueSession(customer));
});
router.post('/login', need((s) => s.customerLoginEnabled, 'Login is currently disabled'), async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const customer = await Customer.findOne({ email: String(email).toLowerCase(), status: 'active' });
  if (!customer || !(await customer.checkPassword(password))) return res.status(401).json({ error: 'Invalid email or password' });
  res.json(await issueSession(customer));
});

/* ---------- account ---------- */
router.get('/me', requireCustomer, (req, res) => res.json(req.customer));

router.put('/me', requireCustomer, async (req, res) => {
  const { name, email, addresses } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = String(name).trim();
  if (email !== undefined && String(email).toLowerCase() !== req.customer.email) {
    if (await Customer.findOne({ email: String(email).toLowerCase(), _id: { $ne: req.customer.id } })) return res.status(409).json({ error: 'That email is already used by another account' });
    updates.email = String(email).toLowerCase();
  }
  if (addresses !== undefined) {
    if (!Array.isArray(addresses) || addresses.length > 10) return res.status(400).json({ error: 'You can save up to 10 addresses' });
    updates.addresses = addresses;
  }
  res.json(await Customer.findByIdAndUpdate(req.customer.id, updates, { new: true, runValidators: true }));
});

/** Orders with their visual journey + any return, newest first. */
router.get('/me/orders', requireCustomer, async (req, res) => {
  const orders = await Order.find({ $or: [{ customerId: req.customer.id }, ...(req.customer.phone ? [{ 'customer.phone': req.customer.phone, customerId: null }] : [])] }).sort({ createdAt: -1 }).limit(50);
  const returns = await Return.find({ order: { $in: orders.map((o) => o._id) } }).select('-images');
  res.json(orders.map((o) => {
    const obj = o.toJSON();
    const ret = returns.find((r) => String(r.order) === o.id);
    return { ...obj, events: undefined, journey: buildJourney(obj), return: ret ? { id: ret.id, status: normalize(ret.status), journey: customerJourney(ret), amount: ret.amount, refund: ret.refund } : null };
  }));
});

/** Website notifications: the customer-visible timeline events across recent orders. */
router.get('/me/updates', requireCustomer, async (req, res) => {
  const orders = await Order.find({ $or: [{ customerId: req.customer.id }, ...(req.customer.phone ? [{ 'customer.phone': req.customer.phone, customerId: null }] : [])] }).sort({ createdAt: -1 }).limit(15).select('orderNumber events');
  const feed = [];
  for (const o of orders) for (const e of o.events) if (e.public !== false && e.label) feed.push({ orderNumber: o.orderNumber, at: e.at, label: e.label, note: e.note, location: e.location });
  feed.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json(feed.slice(0, 40));
});

module.exports = router;
