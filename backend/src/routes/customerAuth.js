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
const { devSender, msg91Sender, brevoSender, zeptomailSender } = require('../utils/otp/senders');
const { brevoFromEnv } = require('../utils/otp/brevoEnv');
const { channelOf, availableChannels, pickChannel, SERVER_PROVIDERS } = require('../utils/otpChannel');
const { msg91FromEnv } = require('../utils/otp/msg91Env');
const { ownedOrdersFilter } = require('../utils/ownership');
const otpStore = require('../services/otpStore');
const { buildJourney } = require('../utils/orderStatus');
const { customerJourney, normalize } = require('../utils/returnStatus');
const { audit } = require('../models/AuditLog');
const { logger } = require('../utils/logger');

const signToken = (c) => jwt.sign({ sub: c.id, type: 'customer' }, process.env.JWT_SECRET, { expiresIn: '30d' });
const termsOk = (req, res) => { if (req.body.termsAccepted === true) return true; res.status(400).json({ error: 'Please accept the Terms & Conditions to continue', code: 'TERMS_REQUIRED' }); return false; };
const issueSession = async (customer, extra = {}) => { customer.lastLoginAt = new Date(); if (!customer.termsAcceptedAt) customer.termsAcceptedAt = new Date(); await customer.save(); return { token: signToken(customer), customer, ...extra }; };

/** Server-side switches, enforced here — hiding a button in the UI is not security. */
function need(test, message) {
  return async (req, res, next) => { const s = await getSettings(); req.settings = s; return test(s) ? next() : res.status(403).json({ error: message }); };
}

async function buildOtpService(settings, channel) {
  let sender;
  const ch = channel || channelOf(settings);
  const notReady = () => new OtpError('NOT_CONFIGURED', ch === 'email' ? 'Email codes are not set up on this store yet' : 'Mobile OTP is not set up on this store yet', 503);
  if (settings.otpProvider === 'dev') sender = devSender();
  else if (ch === 'email') {
    const env = brevoFromEnv();
    if (env) sender = brevoSender({ apiKey: env.apiKey, senderEmail: env.senderEmail, senderName: env.senderName || settings.businessName, baseUrl: process.env.BREVO_BASE_URL || undefined });
    else {
      const prov = ['brevo', 'zeptomail'].includes(settings.otpProvider) ? settings.otpProvider : 'brevo';
      const i = await Integration.findOne({ provider: prov, enabled: true }); if (!i) throw notReady();
      const sec = i.getSecrets(), c = i.config || {};
      sender = prov === 'brevo' ? brevoSender({ apiKey: sec.apiKey, senderEmail: c.senderEmail, senderName: c.senderName || settings.businessName, baseUrl: process.env.BREVO_BASE_URL || undefined })
        : zeptomailSender({ sendMailToken: sec.sendMailToken, senderEmail: c.senderEmail, senderName: c.senderName || settings.businessName, region: c.region || 'in', baseUrl: process.env.ZEPTOMAIL_BASE_URL || undefined });
    }
  } else if (settings.otpProvider === 'firebase') throw new OtpError('NOT_CONFIGURED', 'This store uses Firebase OTP — use the on-screen login', 503);
  else {
    const env = msg91FromEnv();
    if (env) sender = msg91Sender({ authKey: env.authKey, templateId: env.templateId, baseUrl: process.env.MSG91_BASE_URL || undefined });
    else { const i = await Integration.findOne({ provider: 'msg91', enabled: true }); if (!i) throw notReady(); const sec = i.getSecrets(), c = i.config || {}; sender = msg91Sender({ authKey: sec.authKey, templateId: c.templateId, baseUrl: process.env.MSG91_BASE_URL || undefined }); }
  }
  return createOtpService({ store: otpStore, sender, hmacSecret: process.env.OTP_HMAC_SECRET || process.env.JWT_SECRET, channel: ch === 'email' ? 'email' : 'phone' });
}
// Tell the owner WHY login codes are failing (once an hour at most) — customers only see a friendly message.
let lastOtpAlert = 0;
function alertOtpFailure(cause) { if (Date.now() - lastOtpAlert < 3600e3) return; lastOtpAlert = Date.now(); require('../models/Notification').createNotification('otp_failed', `Customers can’t get login codes: ${String(cause || 'unknown error').slice(0, 220)} — check Admin → Integrations → Send test code.`); }
function sendError(res, e) {
  if (e instanceof OtpError) return res.status(e.status).json({ error: e.message, code: e.code, retryAfterSec: e.retryAfterSec });
  throw e;
}

/* ---------- what the storefront is allowed to offer ---------- */
router.get('/auth-options', async (req, res) => {
  const s = await getSettings();
  res.json({ loginEnabled: s.customerLoginEnabled, signupEnabled: s.customerSignupEnabled, otpEnabled: s.otpEnabled && s.otpProvider !== 'none', otpProvider: s.otpProvider, otpChannel: channelOf(s), otpChannels: s.otpEnabled && s.otpProvider !== 'none' ? availableChannels(s) : [], guestCheckoutEnabled: s.guestCheckoutEnabled && !s.requireMobileVerification, requireMobileVerification: s.requireMobileVerification });
});

/* ---------- mobile OTP (server-side codes: provider 'msg91' / 'dev') ---------- */
router.post('/otp/send', need((s) => s.otpEnabled && SERVER_PROVIDERS.includes(s.otpProvider), 'Quick login is taking a short break — you can continue as a guest.'), async (req, res) => {
  try {
    const ch = pickChannel(req.settings, req.body.channel);
    const svc = await buildOtpService(req.settings, ch);
    const email = ch === 'email';
    const r = await svc.send(email ? req.body.email : req.body.phone, req.ip);
    res.json({ sent: true, phone: r.phone, identifier: r.identifier, channel: email ? 'email' : 'phone', expiresInSec: r.expiresInSec, resendAfterSec: r.resendAfterSec, resendsLeft: r.resendsLeft, devCode: r.devCode });
  } catch (e) { if (e instanceof OtpError && e.code === 'SEND_FAILED') { logger.error('otp_send_failed', { cause: e.cause }); alertOtpFailure(e.cause); } sendError(res, e); }
});

router.post('/otp/verify', (req, res, next) => (termsOk(req, res) ? next() : undefined), need((s) => s.otpEnabled && SERVER_PROVIDERS.includes(s.otpProvider), 'Quick login is taking a short break — you can continue as a guest.'), async (req, res) => {
  try {
    const ch = pickChannel(req.settings, req.body.channel);
    const svc = await buildOtpService(req.settings, ch);
    const email = ch === 'email';
    const { phone: id } = await svc.verify(email ? req.body.email : req.body.phone, req.body.code); // `phone` here is the verified identifier (phone OR email)
    const s = req.settings;
    let customer = await Customer.findOne(email ? { email: id } : { phone: id });
    let isNew = false;
    if (!customer) {
      if (!((s.customerSignupEnabled && s.autoCreateAccounts) || s.requireMobileVerification)) return res.status(403).json({ error: 'We’re not opening new accounts at the moment — you can continue as a guest.' });
      customer = await Customer.create({ name: String(req.body.name || '').trim() || 'Craft Lab Customer', ...(email ? { email: id, emailVerified: true } : { phone: id, phoneVerified: true }), authMethod: 'otp' });
      isNew = true;
      await audit({ action: 'customer.created', actor: 'customer', entity: 'customer', entityId: customer.id, summary: `New customer via OTP ${id}`, req });
    } else {
      if (customer.status === 'blocked') return res.status(403).json({ error: 'This account has been blocked. Contact care@thecraftlab.co.in.' });
      if (!(s.customerLoginEnabled || s.requireMobileVerification)) return res.status(403).json({ error: 'Logins are paused for now — you can continue as a guest.' });
      if (email) customer.emailVerified = true; else customer.phoneVerified = true;
      customer.isGuest = false;
    }
    res.json(await issueSession(customer, { isNewCustomer: isNew }));
  } catch (e) { sendError(res, e); }
});

/* ---------- Firebase phone auth (optional alternative provider) ---------- */
router.post('/otp-login', (req, res, next) => (termsOk(req, res) ? next() : undefined), need((s) => s.otpEnabled && s.otpProvider === 'firebase', 'Firebase OTP login is not enabled'), async (req, res) => {
  const { idToken, name } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken is required' });
  let decoded;
  try { decoded = await verifyFirebaseToken(idToken); } catch (err) { return res.status(401).json({ error: 'Invalid or expired OTP session. Please try again.' }); }
  const phone = decoded.phone_number;
  if (!phone) return res.status(400).json({ error: 'No verified phone number on this token' });
  const s = req.settings;
  let customer = await Customer.findOne({ phone }); let isNew = false;
  if (!customer) {
    if (!((s.customerSignupEnabled && s.autoCreateAccounts) || s.requireMobileVerification)) return res.status(403).json({ error: 'We’re not opening new accounts at the moment — you can continue as a guest.' });
    customer = await Customer.create({ name: name || 'Craft Lab Customer', phone, firebaseUid: decoded.uid, authMethod: 'otp', phoneVerified: true }); isNew = true;
  } else {
    if (customer.status === 'blocked') return res.status(403).json({ error: 'This account has been blocked.' });
    if (!(s.customerLoginEnabled || s.requireMobileVerification)) return res.status(403).json({ error: 'Logins are paused for now — you can continue as a guest.' });
    if (!customer.firebaseUid) customer.firebaseUid = decoded.uid;
    customer.phoneVerified = true; customer.isGuest = false;
  }
  res.json(await issueSession(customer, { isNewCustomer: isNew }));
});

/* ---------- email + password (optional) ---------- */
router.post('/signup', (req, res, next) => (termsOk(req, res) ? next() : undefined), need((s) => s.customerSignupEnabled, 'Sign-up is currently disabled'), async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const existing = await Customer.findOne({ email: String(email).toLowerCase() });
  if (existing && !(existing.isGuest && !existing.passwordHash)) return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
  const customer = existing || new Customer({ email, phone: phone || undefined });
  customer.name = String(name).trim(); customer.isGuest = false; customer.authMethod = 'password';
  if (existing && phone && !existing.phone) customer.phone = phone;
  await customer.setPassword(password);
  try { await customer.save(); }
  catch (e) { if (e.code === 11000) return res.status(409).json({ error: 'That email or mobile number already has an account. Log in instead (a one-time code is the quickest way).' }); throw e; }
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

/* ---------- wishlist (kept on the account so it follows the customer across devices) ---------- */
const Product = require('../models/Product');
const cardOf = (p) => ({ id: p.id, name: p.name, slug: p.slug, sku: p.sku, price: p.price, mrp: p.mrp, category: p.category, subcategory: p.subcategory || '', images: (p.images || []).slice(0, 2), available: Math.max(0, p.stock - (p.reserved || 0)), status: p.status });
router.get('/me/wishlist', requireCustomer, async (req, res) => { const ps = await Product.find({ _id: { $in: req.customer.wishlist }, status: 'active' }); res.json({ ids: ps.map((p) => p.id), products: ps.map(cardOf) }); });
// PUT /me/wishlist {ids, merge?} — merge:true adds to what is saved (used when a guest's local wishlist meets their account)
router.put('/me/wishlist', requireCustomer, async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String))].filter((x) => /^[a-f0-9]{24}$/i.test(x)).slice(0, 200);
  const valid = (await Product.find({ _id: { $in: ids }, status: 'active' }).select('_id')).map((p) => String(p._id));
  const next = req.body.merge ? [...new Set([...req.customer.wishlist.map(String), ...valid])] : valid;
  req.customer.wishlist = next; await req.customer.save(); res.json({ ids: next });
});

/** Orders with their visual journey + any return, newest first. */
router.get('/me/orders', requireCustomer, async (req, res) => {
  const orders = await Order.find(ownedOrdersFilter(req.customer)).sort({ createdAt: -1 }).limit(50);
  const returns = await Return.find({ order: { $in: orders.map((o) => o._id) } }).select('-images');
  const ctx = await require('../services/trackLink').loadCtx(); const finish = require('../services/trackLink').finish;
  res.json(orders.map((o) => {
    const obj = o.toJSON();
    const ret = returns.find((r) => String(r.order) === o.id);
    return { ...obj, events: undefined, journey: finish(buildJourney(obj), obj, ctx), return: ret ? { id: ret.id, status: normalize(ret.status), journey: customerJourney(ret), amount: ret.amount, refund: ret.refund } : null };
  }));
});

/** Website notifications: the customer-visible timeline events across recent orders. */
router.get('/me/updates', requireCustomer, async (req, res) => {
  const orders = await Order.find(ownedOrdersFilter(req.customer)).sort({ createdAt: -1 }).limit(15).select('orderNumber events');
  const feed = [];
  for (const o of orders) for (const e of o.events) if (e.public !== false && e.label) feed.push({ orderNumber: o.orderNumber, at: e.at, label: e.label, note: e.note, location: e.location });
  feed.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json(feed.slice(0, 40));
});

module.exports = router;
