// END-TO-END tests: the real Express app + real Mongoose models + a real database engine (FerretDB via FERRET=1, or any MongoDB via TEST_MONGO_URI).
// Only the outside world is faked: Razorpay's SDK, the email API, and the courier API.
if (!process.env.FERRET && !process.env.TEST_MONGO_URI) { console.log('e2e skipped (set FERRET=1 or TEST_MONGO_URI)'); process.exit(0); }
process.env.JWT_SECRET = 'e2e-secret-'.repeat(4); process.env.SECRETS_KEY = 'e2e-secrets-passphrase-12345'; process.env.SITE_URL = 'https://shop.test';
process.env.RATE_LIMIT_SCALE = '40'; process.env.RESEND_API_KEY = 'rk'; process.env.RESEND_FROM = 'Shop <care@shop.test>'; process.env.DISABLE_JOBS = 'true';
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('http'); const crypto = require('crypto');
const request = require('supertest'); const jwt = require('jsonwebtoken');
const db = require('./support/db');

const sentEmails = [], realFetch = globalThis.fetch;
const otpMails = []; // emails sent by the Brevo / ZeptoMail OTP providers
globalThis.fetch = async (url, init) => { if (/api\.(brevo\.com|zeptomail\.in)/.test(String(url))) { otpMails.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) }); return { ok: true, status: 201, json: async () => ({}) }; } if (String(url).includes('api.resend.com')) { sentEmails.push({ ...JSON.parse(init.body) }); return { ok: true, json: async () => ({ id: 'e' }), text: async () => '' }; } return realFetch(url, init); };

let app, M = {}, A, tokens = {}, S = {};
const courier = { awbFails: false, down: false, track: 'In Transit', calls: [] };
const courierServer = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
  const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }; courier.calls.push(req.url);
  if (req.url === '/auth/login') return send(200, { token: 'tok' });
  if (courier.down) return send(503, { message: 'Courier API unavailable' });
  if (req.url === '/orders/create/adhoc') return send(200, { order_id: 9000 + courier.calls.length, shipment_id: 7000 + courier.calls.length });
  if (req.url === '/courier/assign/awb') return courier.awbFails ? send(422, { message: 'No courier serviceable' }) : send(200, { response: { data: { awb_code: 'AWB' + courier.calls.length, courier_name: 'Delhivery' } } });
  if (req.url === '/courier/generate/pickup') return send(200, { response: { pickup_scheduled_date: '2026-10-05' } });
  if (req.url === '/courier/generate/label') return send(200, { label_url: 'https://labels.test/1.pdf' });
  if (req.url.startsWith('/courier/track/awb/')) return send(200, { tracking_data: { track_url: 'https://track.test/x', etd: '2026-10-09', shipment_track_activities: [{ activity: courier.track, location: 'Chennai Hub', date: '2026-10-07 10:00:00' }] } });
  if (req.url === '/orders/cancel') return send(200, { message: 'ok' });
  send(404, {}); }); });
const courierReady = new Promise((r) => courierServer.listen(0, () => { process.env.SHIPROCKET_BASE_URL = `http://127.0.0.1:${courierServer.address().port}`; r(); }));
const WH_SECRET = 'whsec_e2e', KEY_SECRET = 'rzp_secret_e2e';
let rzCounter = 0; const rzOrders = {}, rzRefunds = [], rzPaymentsByOrder = {};
const fakeRazorpay = {
  orders: { create: async (o) => { const id = 'order_' + ++rzCounter; rzOrders[id] = o; return { id, ...o }; }, fetchPayments: async (id) => ({ items: rzPaymentsByOrder[id] || [] }) },
  payments: { refund: async (pid, o) => { const r = { id: 'rfnd_' + (rzRefunds.length + 1), status: 'pending', payment_id: pid, ...o }; rzRefunds.push(r); return r; }, fetch: async () => ({}) },
};
const sign = (orderId, payId) => crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${payId}`).digest('hex');
const hook = (event, payload, id) => { const body = JSON.stringify({ event, payload }); return request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', crypto.createHmac('sha256', WH_SECRET).update(body).digest('hex')).set('x-razorpay-event-id', id || 'evt_' + Math.random().toString(36).slice(2)).send(body); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mongoose = require('mongoose');
const ageOrder = (id, minutes) => M.Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: { createdAt: new Date(Date.now() - minutes * 60e3) } });
const clearOtpCooldown = () => require('../src/models/OtpRequest').collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 600e3) } });
const addr = { line1: '12 Test Street', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' };
async function cartWith(items) { const c = (await request(app).post('/api/cart')).body.cartId; for (const [p, q] of items) await request(app).post(`/api/cart/${c}/items`).send({ productId: p.id, qty: q }); return c; }
const place = (cartId, extra = {}) => request(app).post('/api/checkout').set(extra.auth ? { Authorization: 'Bearer ' + extra.auth } : {}).send({ cartId, paymentMethod: 'cod', customer: { name: 'Asha K', phone: '9876543210', email: 'asha@example.com' }, address: addr, ...extra.body });
const stockOf = async (p) => (await M.Product.findById(p.id)).stock;
const reservedOf = async (p) => (await M.Product.findById(p.id)).reserved;

test('SETUP: database, admin users, products, settings', async () => {
  await courierReady; await db.start();
  const { createApp } = require('../src/app'); app = createApp();
  for (const n of ['Product', 'Order', 'Customer', 'Admin', 'Coupon', 'Return', 'Settings', 'AuditLog', 'StockMovement', 'NotificationLog', 'WebhookEvent', 'Integration', 'PurchaseOrder', 'Supplier', 'Cart', 'Notification']) M[n] = require('../src/models/' + n);
  const { setPaymentProvider, razorpayProvider } = require('../src/utils/paymentProvider');
  setPaymentProvider(razorpayProvider({ keyId: 'rzp_test_e2e', keySecret: KEY_SECRET, webhookSecret: WH_SECRET, client: fakeRazorpay }));
  process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
  for (const [email, role] of [['owner@shop.test', 'ADMIN'], ['staff@shop.test', 'STAFF']]) { const a = new M.Admin({ name: role, email, role }); await a.setPassword('Passw0rd!x'); await a.save(); }
  const login = async (email, password = 'Passw0rd!x') => request(app).post('/api/auth/login').send({ email, password });
  tokens.owner = (await login('owner@shop.test')).body.token; tokens.staff = (await login('staff@shop.test')).body.token;
  assert.ok(tokens.owner && tokens.staff); A = (t) => ({ Authorization: 'Bearer ' + t });
  S.p1 = await M.Product.create({ name: 'Sculptural Rack', slug: 'sculptural-rack', sku: 'SKU1', price: 2499, mrp: 2999, stock: 200, lowStockThreshold: 2, images: ['images/a.jpg'] });
  S.p2 = await M.Product.create({ name: 'Row Rack', slug: 'row-rack', sku: 'SKU2', price: 1500, mrp: 1800, stock: 3, lowStockThreshold: 2 });
  const { getSettings } = require('../src/models/Settings'); const st = await getSettings();
  Object.assign(st, { codEnabled: true, prepaidDiscountPercent: 5, otpEnabled: true, otpProvider: 'dev', state: 'Tamil Nadu', defaultTaxRate: 18, returnWindowDays: 7, invoicePrefix: 'INV', email: 'owner@shop.test' }); await st.save();
});

test('public config exposes only safe settings and the auth switches', async () => {
  const r = await request(app).get('/api/config/public'); assert.equal(r.status, 200);
  assert.deepEqual(r.body.auth, { loginEnabled: true, signupEnabled: true, otpEnabled: true, otpProvider: 'dev', otpChannel: 'phone', guestCheckoutEnabled: true, requireMobileVerification: false });
  assert.equal(r.body.codEnabled, true); assert.equal(r.body.prepaidDiscountPercent, 5); assert.equal(r.body.business.gstin, '');
  assert.ok(!JSON.stringify(r.body).includes('Secret') && !('jwt' in r.body));
});

/* ================= authentication switches (enforced on the server) ================= */
test('OTP login: send → wrong code → right code creates the account; same number is recognised next time', async () => {
  const s1 = await request(app).post('/api/customers/otp/send').send({ phone: '98765 43210' }); assert.equal(s1.status, 200); assert.match(s1.body.devCode, /^\d{6}$/); assert.equal(s1.body.phone, '+919876543210');
  assert.equal((await request(app).post('/api/customers/otp/send').send({ phone: '9876543210' })).status, 429, 'resend cool-down');
  const wrong = await request(app).post('/api/customers/otp/verify').send({ termsAccepted: true, phone: '9876543210', code: s1.body.devCode === '000000' ? '111111' : '000000' }); assert.equal(wrong.status, 400); assert.match(wrong.body.error, /Incorrect code/);
  const ok = await request(app).post('/api/customers/otp/verify').send({ termsAccepted: true, phone: '9876543210', code: s1.body.devCode, name: 'Asha K' });
  assert.equal(ok.status, 200); assert.equal(ok.body.isNewCustomer, true); assert.equal(ok.body.customer.phone, '+919876543210'); assert.equal(ok.body.customer.phoneVerified, true); assert.equal(ok.body.customer.passwordHash, undefined);
  tokens.asha = ok.body.token; S.ashaId = ok.body.customer.id;
  assert.equal((await request(app).get('/api/customers/me').set(A(tokens.asha))).body.name, 'Asha K');
  assert.equal((await request(app).post('/api/customers/otp/verify').send({ termsAccepted: true, phone: '9876543210', code: s1.body.devCode })).status, 400, 'a code can only be used once');
  await clearOtpCooldown();
  const s2 = await request(app).post('/api/customers/otp/send').send({ phone: '9876543210' }); const again = await request(app).post('/api/customers/otp/verify').send({ termsAccepted: true, phone: '9876543210', code: s2.body.devCode });
  assert.equal(again.body.isNewCustomer, false); assert.equal(await M.Customer.countDocuments({ phone: '+919876543210' }), 1, 'no duplicate account for a verified number');
});
test('admin switches: OTP off, sign-up off, login off, blocked accounts', async () => {
  const set = (b) => request(app).put('/api/admin/settings').set(A(tokens.owner)).send(b);
  const otp = async (phone) => { const s = await request(app).post('/api/customers/otp/send').send({ phone }); if (s.status !== 200) return s; return request(app).post('/api/customers/otp/verify').send({ termsAccepted: true, phone, code: s.body.devCode }); };
  const clearCooldown = clearOtpCooldown;
  assert.equal((await set({ otpEnabled: false })).status, 200);
  assert.equal((await request(app).post('/api/customers/otp/send').send({ phone: '9123456780' })).status, 403, 'OTP switched off');
  assert.equal((await request(app).get('/api/customers/auth-options')).body.otpEnabled, false);
  await set({ otpEnabled: true, customerSignupEnabled: false }); await clearCooldown();
  assert.equal((await otp('9123456780')).status, 403, 'new accounts disabled — a brand-new number is refused'); assert.equal(await M.Customer.countDocuments({ phone: '+919123456780' }), 0);
  assert.equal((await otp('9876543210')).status, 200, 'existing customers can still log in'); await clearCooldown();
  await set({ customerSignupEnabled: true, customerLoginEnabled: false }); await clearCooldown();
  assert.equal((await otp('9876543210')).status, 403, 'login disabled');
  assert.equal((await request(app).post('/api/customers/login').send({ email: 'a@b.com', password: 'x' })).status, 403);
  await set({ customerLoginEnabled: true }); await clearCooldown();
  await M.Customer.updateOne({ _id: S.ashaId }, { $set: { status: 'blocked' } }); assert.equal((await otp('9876543210')).status, 403, 'blocked customers are refused'); assert.equal((await request(app).get('/api/customers/me').set(A(tokens.asha))).status, 401, 'and their existing session stops working');
  await M.Customer.updateOne({ _id: S.ashaId }, { $set: { status: 'active' } });
  assert.equal((await set({ guestCheckoutEnabled: false, customerLoginEnabled: false })).status, 400, 'can’t switch off every way to buy');
  assert.equal((await request(app).put('/api/admin/settings').set(A(tokens.staff)).send({ codEnabled: false })).status, 403, 'STAFF cannot change settings');
  assert.equal((await set({ otpProvider: 'bogus' })).status, 400);
});
test('guest checkout / mandatory mobile verification are enforced at checkout', async () => {
  const set = (b) => request(app).put('/api/admin/settings').set(A(tokens.owner)).send(b);
  await set({ guestCheckoutEnabled: false });
  let c = await cartWith([[S.p1, 1]]); let r = await place(c); assert.equal(r.status, 401); assert.equal(r.body.code, 'LOGIN_REQUIRED');
  assert.equal(await stockOf(S.p1), 200, 'a refused checkout reserves nothing'); assert.equal(await reservedOf(S.p1), 0);
  r = await place(c, { auth: tokens.asha }); assert.equal(r.status, 201, 'logged-in customers can buy'); S.orderLoggedIn = r.body;
  await set({ guestCheckoutEnabled: true, requireMobileVerification: true });
  c = await cartWith([[S.p1, 1]]); assert.equal((await place(c)).status, 401, 'guests refused when mobile verification is mandatory');
  await M.Customer.updateOne({ _id: S.ashaId }, { $set: { phoneVerified: false } }); assert.equal((await place(c, { auth: tokens.asha })).status, 401, 'an unverified account is not enough');
  await M.Customer.updateOne({ _id: S.ashaId }, { $set: { phoneVerified: true } });
  r = await place(c, { auth: tokens.asha, body: { customer: { name: 'Asha K', phone: '9000000001', email: 'asha@example.com' } } }); assert.equal(r.status, 201);
  assert.equal((await M.Order.findById(r.body.orderId)).customer.phone, '+919876543210', 'the order uses the VERIFIED phone, not what the browser sent');
  await set({ requireMobileVerification: false });
});

/* ================= checkout: COD ================= */
test('COD order: totals computed on the server, stock deducted, invoice + timeline + notifications', async () => {
  const before = await stockOf(S.p1); const c = await cartWith([[S.p1, 2], [S.p2, 1]]);
  const r = await place(c, { body: { giftMessage: 'Happy housewarming!', attribution: { source: 'Instagram', medium: 'social', campaign: 'launch' } } });
  assert.equal(r.status, 201); assert.equal(r.body.cod, true); assert.match(r.body.orderNumber, /^FY\d{4}CL\d{3,}$/); assert.equal(r.body.total, 2499 * 2 + 1500, 'no prepaid discount on COD');
  const o = await M.Order.findById(r.body.orderId); S.cod = o;
  assert.equal(o.orderStatus, 'Processing'); assert.equal(o.paymentStatus, 'Pending'); assert.equal(o.payment.method, 'cod'); assert.equal(o.customer.phone, '+919876543210');
  assert.equal(await stockOf(S.p1), before - 2); assert.equal(await reservedOf(S.p1), 0, 'reservation converted to a real deduction');
  assert.match(o.invoiceNumber, /^INV-\d+$/); assert.equal(o.taxRate, 18); assert.equal(o.taxAmount, Math.round((o.total - o.total / 1.18) * 100) / 100);
  assert.deepEqual(o.events.filter((e) => e.public).map((e) => e.stage).filter(Boolean), ['placed', 'paid', 'processing']); assert.equal(o.attribution.source, 'instagram');
  const mv = await M.StockMovement.find({ ref: o.orderNumber }); assert.deepEqual(mv.map((m) => m.delta).sort((a, b) => a - b), [-2, -1]); assert.ok(mv.every((m) => m.reason === 'cod_order'));
  await wait(300); const mail = sentEmails.find((e) => e.to === 'asha@example.com' && /Order confirmed/.test(e.subject)); assert.ok(mail, 'confirmation email sent to the customer'); assert.match(mail.html, /order-tracking\.html\?order=FY\d{4}CL/);
  assert.ok(sentEmails.find((e) => e.to === 'owner@shop.test' && /New COD order/.test(e.subject)), 'owner alerted by email');
  assert.equal(await M.NotificationLog.countDocuments({ orderNumber: o.orderNumber, channel: 'email', event: 'order_placed', status: 'sent' }), 1);
  assert.equal(await M.Notification.countDocuments({ type: 'new_order' }) > 0, true, 'admin bell notified');
});
test('validation: bad phone/email/PIN, COD disabled, empty cart, unavailable stock', async () => {
  const c = await cartWith([[S.p1, 1]]);
  for (const body of [{ customer: { name: 'A', phone: '12345', email: 'a@b.com' } }, { customer: { name: 'A', phone: '9876543210', email: 'nope' } }, { address: { ...addr, pincode: '60001' } }, { address: { line1: '', city: 'c', state: 's', pincode: '600001' } }]) assert.equal((await place(c, { body })).status, 400);
  assert.equal((await place('doesnotexist')).status, 400, 'unknown cart');
  await request(app).put('/api/admin/settings').set(A(tokens.owner)).send({ codEnabled: false }); assert.equal((await place(c)).status, 400); await request(app).put('/api/admin/settings').set(A(tokens.owner)).send({ codEnabled: true });
  const big = await cartWith([[S.p2, 99]]); const r = await place(big); assert.equal(r.status, 409); assert.match(r.body.error, /Not enough stock/); assert.equal(await reservedOf(S.p2), 0, 'nothing left reserved after a failed checkout');
});
test('idempotency: double-click / refresh returns the SAME order and deducts stock once', async () => {
  const before = await stockOf(S.p1); const c = await cartWith([[S.p1, 1]]); const key = 'idem-' + Date.now() + '-aaaa';
  const a = await place(c, { body: { idempotencyKey: key } }), b = await place(c, { body: { idempotencyKey: key } });
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.body.duplicate, true); assert.equal(b.body.orderNumber, a.body.orderNumber);
  assert.equal(await stockOf(S.p1), before - 1); assert.equal(await M.Order.countDocuments({ cartId: c }), 1);
});
test('overselling is impossible: stock 3, five simultaneous buyers → exactly 3 orders', async () => {
  const p = await M.Product.create({ name: 'Last Pieces', slug: 'last-pieces', sku: 'SKU3', price: 100, mrp: 100, stock: 3 });
  const carts = await Promise.all([1, 2, 3, 4, 5].map(() => cartWith([[p, 1]])));
  const res = await Promise.all(carts.map((c) => place(c)));
  assert.equal(res.filter((r) => r.status === 201).length, 3); assert.equal(res.filter((r) => r.status === 409).length, 2);
  assert.equal(await stockOf(p), 0); assert.equal(await reservedOf(p), 0);
});
test('coupons: percentage discount, usage limit holds, released when checkout is abandoned', async () => {
  await M.Coupon.create({ code: 'ONCE10', type: 'percentage', value: 10, usageLimit: 1 });
  let c = await cartWith([[S.p1, 1]]); const r = await place(c, { body: { couponCode: 'once10' } });
  assert.equal(r.status, 201); assert.equal(r.body.total, 2499 - 250); assert.equal((await M.Coupon.findOne({ code: 'ONCE10' })).usedCount, 1);
  c = await cartWith([[S.p1, 1]]); const r2 = await place(c, { body: { couponCode: 'ONCE10' } }); assert.equal(r2.status, 400); assert.match(r2.body.error, /usage limit/);
  assert.equal(await reservedOf(S.p1), 0, 'a refused coupon leaves no stock reserved'); assert.equal((await place(c, { body: { couponCode: 'NOPE' } })).status, 400);
});

/* ================= checkout: online payment, signatures, webhooks, reconciliation ================= */
async function onlineOrder(items = [[S.p1, 1]], extra = {}) {
  const c = await cartWith(items); const r = await request(app).post('/api/checkout').send({ cartId: c, paymentMethod: 'online', customer: { name: 'Ravi S', phone: '9812345678', email: 'ravi@example.com' }, address: addr, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body;
}
test('online order: 5% prepaid discount applied, stock RESERVED (not deducted) until paid', async () => {
  const stock = await stockOf(S.p1), res = await reservedOf(S.p1); const o = await onlineOrder();
  assert.equal(o.total, 2499 - Math.round(2499 * 0.05)); assert.equal(o.razorpayKeyId, 'rzp_test_e2e'); assert.equal(rzOrders[o.razorpayOrderId].amount, o.total * 100); assert.equal(rzOrders[o.razorpayOrderId].currency, 'INR');
  assert.equal(await stockOf(S.p1), stock); assert.equal(await reservedOf(S.p1), res + 1); const d = await M.Order.findById(o.orderId); assert.equal(d.orderStatus, 'Pending'); assert.equal(d.paymentStatus, 'Pending'); S.online = o;
});
test('payment verify: forged signature refused; real signature confirms ONCE even if replayed or raced with the webhook', async () => {
  const o = S.online; const pay = 'pay_' + Date.now(); const stock = await stockOf(S.p1);
  assert.equal((await request(app).post('/api/payments/verify').send({ orderId: o.orderId, razorpay_order_id: o.razorpayOrderId, razorpay_payment_id: pay, razorpay_signature: 'forged' })).status, 400);
  assert.equal((await M.Order.findById(o.orderId)).paymentStatus, 'Pending', 'a forged confirmation changes nothing');
  assert.equal((await request(app).post('/api/payments/verify').send({ orderId: S.cod.id, razorpay_order_id: o.razorpayOrderId, razorpay_payment_id: pay, razorpay_signature: sign(o.razorpayOrderId, pay) })).status, 400, 'a valid signature for a different order is refused');
  const body = { orderId: o.orderId, razorpay_order_id: o.razorpayOrderId, razorpay_payment_id: pay, razorpay_signature: sign(o.razorpayOrderId, pay) };
  const captured = { payment: { entity: { id: pay, order_id: o.razorpayOrderId, amount: o.total * 100, currency: 'INR', method: 'upi' } } };
  const results = await Promise.all([request(app).post('/api/payments/verify').send(body), hook('payment.captured', captured, 'evt_race'), request(app).post('/api/payments/verify').send(body)]);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  const d = await M.Order.findById(o.orderId); assert.equal(d.paymentStatus, 'Paid'); assert.equal(d.orderStatus, 'Paid'); assert.equal(d.payment.razorpayPaymentId, pay); assert.ok(d.payment.verifiedAt);
  assert.equal(await stockOf(S.p1), stock - 1, 'stock deducted exactly once despite three confirmations'); assert.equal(await M.StockMovement.countDocuments({ ref: d.orderNumber }), 1);
  await wait(500); assert.equal(d.events.filter((e) => e.stage === 'paid').length, 1); assert.equal(await M.NotificationLog.countDocuments({ orderNumber: d.orderNumber, event: 'order_placed' }) > 0, true);
  assert.equal(await M.NotificationLog.countDocuments({ orderNumber: d.orderNumber, event: 'payment_confirmed', channel: 'email' }), 1, 'the customer is told once');
  assert.match(d.invoiceNumber, /^INV-/); S.paidOnline = d; S.payId = pay;
});
test('webhooks: duplicate event ids ignored, bad signatures refused, amount mismatch rejected, failures recorded', async () => {
  const o2 = await onlineOrder(); const pay = 'pay_dup_' + Date.now(); const stock = await stockOf(S.p1);
  const ev = { payment: { entity: { id: pay, order_id: o2.razorpayOrderId, amount: o2.total * 100, currency: 'INR', method: 'card' } } };
  assert.equal((await hook('payment.captured', ev, 'evt_dup')).body.duplicate, undefined); const dup = await hook('payment.captured', ev, 'evt_dup'); assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true);
  assert.equal(await stockOf(S.p1), stock - 1 + 0, 'second delivery changed nothing'); assert.equal((await M.Order.findById(o2.orderId)).payment.razorpayMethod, 'card');
  const o3 = await onlineOrder(); const bad = await hook('payment.captured', { payment: { entity: { id: 'pay_x', order_id: o3.razorpayOrderId, amount: 100, currency: 'INR', method: 'upi' } } }, 'evt_mismatch');
  assert.equal(bad.status, 500, 'non-2xx so Razorpay retries / we investigate'); assert.equal((await M.Order.findById(o3.orderId)).paymentStatus, 'Pending', 'an under-paid event never confirms the order');
  assert.equal((await M.WebhookEvent.findOne({ eventId: 'evt_mismatch' })).status, 'failed'); assert.ok(await M.Notification.findOne({ message: /amount mismatch/i }));
  const failed = await hook('payment.failed', { payment: { entity: { id: 'pay_f', order_id: o3.razorpayOrderId, error_description: 'Insufficient funds' } } }, 'evt_failed'); assert.equal(failed.status, 200);
  const d3 = await M.Order.findById(o3.orderId); assert.equal(d3.paymentStatus, 'Failed'); assert.equal(d3.orderStatus, 'Pending'); S.failedOrder = o3;
  assert.equal((await request(app).post('/api/webhooks/razorpay').set('x-razorpay-signature', 'bad').send('{}')).status, 400);
  assert.equal((await hook('some.unknown.event', {}, 'evt_unknown')).status, 200); assert.equal((await M.WebhookEvent.findOne({ eventId: 'evt_unknown' })).status, 'ignored');
});
test('reconciliation recovers a payment whose webhook and callback were both lost', async () => {
  const lost = await onlineOrder(); await ageOrder(lost.orderId, 20);
  rzPaymentsByOrder[lost.razorpayOrderId] = [{ id: 'pay_lost', status: 'captured', amount: lost.total * 100, currency: 'INR', method: 'upi' }];
  const stock = await stockOf(S.p1); const r = await request(app).post('/api/admin/payments/reconcile').set(A(tokens.owner)); assert.equal(r.status, 200); assert.ok(r.body.recovered >= 1);
  const d = await M.Order.findById(lost.orderId); assert.equal(d.paymentStatus, 'Paid'); assert.equal(d.payment.verifiedVia, 'reconcile'); assert.equal(await stockOf(S.p1), stock - 1);
  assert.equal((await request(app).post('/api/admin/payments/reconcile').set(A(tokens.owner))).body.recovered, 0, 'running it again changes nothing');
  const wrongAmt = await onlineOrder(); await ageOrder(wrongAmt.orderId, 20);
  rzPaymentsByOrder[wrongAmt.razorpayOrderId] = [{ id: 'pay_w', status: 'captured', amount: 1, currency: 'INR' }]; await request(app).post('/api/admin/payments/reconcile').set(A(tokens.owner));
  assert.equal((await M.Order.findById(wrongAmt.orderId)).paymentStatus, 'Pending', 'a payment of the wrong amount is never accepted');
});
test('abandoned online checkout: closing the payment window releases stock; stale holds are released; late payment on a cancelled order is flagged, not lost', async () => {
  const o = await onlineOrder(); const reserved = await reservedOf(S.p1);
  assert.equal((await request(app).post(`/api/checkout/${o.orderId}/cancel`).send({})).status, 403, 'knowing the order id alone cannot cancel it');
  assert.equal((await request(app).post(`/api/checkout/${o.orderId}/cancel`).send({ razorpayOrderId: o.razorpayOrderId })).status, 200);
  assert.equal(await reservedOf(S.p1), reserved - 1); assert.equal((await M.Order.findById(o.orderId)).orderStatus, 'Cancelled');
  const stale = await onlineOrder(); await ageOrder(stale.orderId, 45);
  const rel = await request(app).post('/api/admin/orders/release-stale').set(A(tokens.owner)).send({}); assert.equal(rel.status, 200); assert.ok(rel.body.released >= 1); assert.equal((await M.Order.findById(stale.orderId)).orderStatus, 'Cancelled');
  const stock = await stockOf(S.p1); const pay = 'pay_late';
  const r = await request(app).post('/api/payments/verify').send({ orderId: o.orderId, razorpay_order_id: o.razorpayOrderId, razorpay_payment_id: pay, razorpay_signature: sign(o.razorpayOrderId, pay) }); assert.equal(r.status, 200);
  const d = await M.Order.findById(o.orderId); assert.equal(d.paymentStatus, 'Paid'); assert.equal(d.orderStatus, 'Cancelled'); assert.equal(await stockOf(S.p1), stock, 'no stock deducted for a cancelled order');
  assert.ok(await M.Notification.findOne({ message: /CANCELLED order.*refund/i }), 'admin is told money arrived for a cancelled order');
});

const adm = (method, path, body, token) => { let r = request(app)[method]('/api/admin' + path).set(A(token || tokens.owner)); return body !== undefined ? r.send(body) : r; };
async function payOnline(o, method = 'upi') { const pay = 'pay_' + Math.random().toString(36).slice(2, 10); const r = await request(app).post('/api/payments/verify').send({ orderId: o.orderId, razorpay_order_id: o.razorpayOrderId, razorpay_payment_id: pay, razorpay_signature: sign(o.razorpayOrderId, pay) }); assert.equal(r.status, 200); return pay; }
const mails = (to, re) => sentEmails.filter((e) => e.to === to && re.test(e.subject));

/* ================= fulfilment lifecycle ================= */
test('admin order list: server-side paging, search by number / phone, filters', async () => {
  const p1 = await adm('get', '/orders?limit=3&page=1'); assert.equal(p1.status, 200); assert.equal(p1.body.orders.length, 3); assert.ok(p1.body.total > 6); assert.equal(p1.body.pages, Math.ceil(p1.body.total / 3));
  assert.ok(p1.body.orders[0].createdAt >= p1.body.orders[1].createdAt, 'newest first'); assert.equal(p1.body.orders[0].events, undefined, 'list stays light — no timelines');
  const byNum = await adm('get', '/orders?q=' + S.cod.orderNumber.toLowerCase()); assert.equal(byNum.body.total, 1); assert.equal(byNum.body.orders[0].orderNumber, S.cod.orderNumber);
  assert.ok((await adm('get', '/orders?q=3210')).body.total >= 3, 'search by the last digits of a phone number');
  assert.ok((await adm('get', '/orders?mode=cod')).body.orders.every((o) => o.payment.method === 'cod')); assert.ok((await adm('get', '/orders?mode=online')).body.orders.every((o) => o.payment.method !== 'cod'));
  assert.equal((await adm('get', '/orders?status=Processing')).body.orders.every((o) => o.orderStatus === 'Processing'), true); assert.ok((await adm('get', '/orders')).body.counts.Processing > 0);
  assert.equal((await adm('get', '/orders', undefined, tokens.staff)).status, 200, 'STAFF can work orders');
});
test('status changes: only valid transitions, timeline + notifications, COD becomes Paid on delivery', async () => {
  const id = S.cod.id; const st = (status, token) => adm('put', `/orders/${id}/status`, { orderStatus: status }, token);
  assert.equal((await st('Processing')).status, 409, 'cannot go "back" to the status it is already in'); assert.equal((await st('Refunded')).status, 400, 'Refunded is only reachable through the refund flow');
  assert.equal((await st('Bogus')).status, 409);
  let r = await st('Packed', tokens.staff); assert.equal(r.status, 200, 'STAFF may update fulfilment'); assert.ok(r.body.allowedNext.includes('Dispatched'));
  assert.equal((await st('Processing')).status, 409, 'no moving backwards');
  const d1 = await adm('put', `/orders/${id}/delivery`, { partner: 'Delhivery', trackingId: 'DL12345', expectedDelivery: '2026-10-12' }); assert.equal(d1.status, 200);
  assert.equal((await st('Dispatched')).status, 200); assert.equal((await st('OutForDelivery')).status, 200); assert.equal((await st('Delivered')).status, 200);
  const o = await M.Order.findById(id); assert.equal(o.paymentStatus, 'Paid', 'cash collected on delivery'); assert.ok(o.deliveredAt); assert.ok(o.delivery.dispatchDate);
  assert.deepEqual(o.events.filter((e) => e.public && e.stage).map((e) => e.stage), ['placed', 'paid', 'processing', 'packed', 'handed', 'out', 'delivered']);
  assert.equal((await st('Cancelled')).status, 409, 'a delivered order cannot be cancelled'); assert.equal((await st('Packed')).status, 409);
  await wait(400);
  for (const re of [/Order packed/, /Order shipped/, /Out for delivery/, /Delivered/]) assert.equal(mails('asha@example.com', re).length, 1, String(re));
  assert.match(mails('asha@example.com', /Order shipped/)[0].html, /Delhivery|DL12345/);
  const unpaid = await M.Order.findById(S.failedOrder.orderId); assert.equal((await adm('put', `/orders/${unpaid.id}/status`, { orderStatus: 'Packed' })).status, 409, 'an unpaid online order cannot be fulfilled');
  assert.equal((await adm('put', `/orders/${id}/note`.replace('/note', '/status'), { orderStatus: 'Delivered' })).status, 409);
  assert.equal((await adm('post', `/orders/${id}/note`, { note: 'Packed with extra foam', visibleToCustomer: false })).status, 200);
});
test('customer tracking: visual journey answers "where is my order"; wrong email/phone reveals nothing', async () => {
  const t = await request(app).get(`/api/track?orderNumber=${S.cod.orderNumber}&email=ASHA@example.com`); assert.equal(t.status, 200);
  const j = t.body.journey; assert.equal(j.stages.length, 8); assert.ok(j.stages.every((x) => x.state === 'done')); assert.equal(j.progressPct, 100); assert.match(j.headline, /Delivered/); assert.equal(j.courier.name, 'Delhivery'); assert.equal(j.courier.awb, 'DL12345'); assert.ok(j.stages[7].at);
  assert.ok(!JSON.stringify(t.body).includes('Packed with extra foam'), 'internal notes never reach the customer'); assert.ok(!JSON.stringify(t.body).includes('Inventory updated'));
  assert.equal((await request(app).get(`/api/track?orderNumber=${S.cod.orderNumber}&phone=9876543210`)).status, 200); assert.equal((await request(app).get(`/api/track?orderNumber=${S.cod.orderNumber}&email=other@example.com`)).status, 404);
  assert.equal((await request(app).get('/api/track?orderNumber=' + S.cod.orderNumber)).status, 400); assert.equal((await request(app).get('/api/track?orderNumber=CL-99999999&email=a@b.com')).status, 404);
  const pend = await request(app).get(`/api/track?orderNumber=${(await M.Order.findById(S.failedOrder.orderId)).orderNumber}&email=ravi@example.com`); assert.equal(pend.body.journey.stages[1].state, 'current'); assert.match(pend.body.journey.stages[1].label, /Awaiting payment/);
});
test('cancellation restores stock; paid-online cancellation raises a refund-due alert; COD does not', async () => {
  const before = await stockOf(S.p2); let c = await cartWith([[S.p2, 1]]); const cod = (await place(c)).body; assert.equal(await stockOf(S.p2), before - 1);
  const r = await adm('post', `/orders/${cod.orderId}/cancel`, { reason: 'customer asked' }); assert.equal(r.status, 200); assert.equal(r.body.refundDue, false); assert.equal(await stockOf(S.p2), before, 'stock back on the shelf');
  assert.equal((await M.Order.findById(cod.orderId)).orderStatus, 'Cancelled'); assert.equal((await adm('post', `/orders/${cod.orderId}/cancel`, {})).status, 409, 'cannot cancel twice'); await wait(300); assert.equal(mails('asha@example.com', /Order cancelled/).length, 1);
  const on = await onlineOrder([[S.p2, 1]]); await payOnline(on); const sb = await stockOf(S.p2); const r2 = await adm('post', `/orders/${on.orderId}/cancel`, {}); assert.equal(r2.body.refundDue, true); assert.equal(await stockOf(S.p2), sb + 1);
  assert.ok(await M.Notification.findOne({ message: new RegExp(`${(await M.Order.findById(on.orderId)).orderNumber}.*refund`, 'i') }));
});
test('customer account: orders with journeys, updates feed, saved addresses', async () => {
  const o = await request(app).get('/api/customers/me/orders').set(A(tokens.asha)); assert.equal(o.status, 200); assert.ok(o.body.length >= 3);
  const cod = o.body.find((x) => x.orderNumber === S.cod.orderNumber); assert.ok(cod, 'a guest COD order placed with the same verified number appears in the account'); assert.equal(cod.journey.stages.length, 8); assert.equal(cod.events, undefined);
  const u = await request(app).get('/api/customers/me/updates').set(A(tokens.asha)); assert.ok(u.body.length > 3); assert.ok(u.body.every((x) => x.label && x.orderNumber)); assert.ok(!u.body.some((x) => /Inventory|Internal note/.test(x.label)));
  const up = await request(app).put('/api/customers/me').set(A(tokens.asha)).send({ name: 'Asha Kumar', addresses: [{ label: 'Home', receiverName: 'Asha', line1: '12 Test Street', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' }] }); assert.equal(up.status, 200); assert.equal(up.body.addresses.length, 1);
  assert.equal((await request(app).put('/api/customers/me').set(A(tokens.asha)).send({ addresses: new Array(11).fill({}) })).status, 400);
});

/* ================= returns → refunds ================= */
const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
test('customer return request: eligibility, partial quantities, photo rules, ownership', async () => {
  const el = await request(app).get(`/api/returns/eligible/${S.cod.id}`).set(A(tokens.asha)); assert.equal(el.body.eligible, true); assert.deepEqual(el.body.lines.map((l) => l.eligible), [2, 1]); assert.equal(el.body.window.open, true);
  const post = (b, t = tokens.asha) => request(app).post('/api/returns').set(A(t)).send({ orderId: S.cod.id, reason: 'Damaged on arrival', ...b });
  assert.equal((await post({ reason: 'because' })).status, 400); assert.equal((await post({ items: [{ index: 0, qty: 3 }] })).status, 400, 'more than ordered'); assert.equal((await post({ items: [{ index: 9, qty: 1 }] })).status, 400);
  assert.equal((await post({ images: [jpeg, jpeg, jpeg, jpeg, jpeg] })).status, 400, 'max 4 photos'); assert.equal((await post({ images: ['data:text/html;base64,PHNjcmlwdD4='] })).status, 400, 'only real images'); assert.equal((await post({ images: [jpeg.replace('image/jpeg', 'image/svg+xml')] })).status, 400);
  const other = (await request(app).post('/api/customers/otp/send').send({ phone: '9555555555' })); const ot = await request(app).post('/api/customers/otp/verify').send({ termsAccepted: true, phone: '9555555555', code: other.body.devCode });
  assert.equal((await post({}, ot.body.token)).status, 404, 'cannot return someone else’s order');
  assert.equal((await request(app).post('/api/returns').set(A(tokens.asha)).send({ orderId: S.orderLoggedIn.orderId, reason: 'Damaged on arrival' })).status, 400, 'not delivered yet');
  const r = await post({ items: [{ index: 0, qty: 1 }], comments: 'one peg cracked', resolution: 'Refund', images: [jpeg] }); assert.equal(r.status, 201); assert.equal(r.body.amount, 2499); S.ret1 = r.body.id;
  const r2 = await post({ items: [{ index: 0, qty: 1 }] }); assert.equal(r2.status, 201, 'the second unit can be returned separately'); S.ret2 = r2.body.id;
  const r3 = await post({ items: [{ index: 0, qty: 1 }] }); assert.equal(r3.status, 400, 'a unit already in a return cannot be returned again');
  const mine = await request(app).get('/api/returns/mine').set(A(tokens.asha)); assert.equal(mine.body.length, 2); assert.equal(mine.body[0].images, undefined); assert.equal(mine.body[0].journey.steps[0].state, 'current');
  assert.ok(await M.Notification.findOne({ type: 'return_requested' }));
});
test('return window: a delivered order older than the window cannot be returned', async () => {
  const c = await cartWith([[S.p1, 1]]); const o = (await place(c)).body; for (const s of ['Packed', 'Dispatched', 'Delivered']) await adm('put', `/orders/${o.orderId}/status`, { orderStatus: s });
  await M.Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(o.orderId) }, { $set: { deliveredAt: new Date(Date.now() - 10 * 86400e3) } });
  const el = await request(app).get(`/api/returns/eligible/${o.orderId}`).set(A(tokens.asha)); assert.equal(el.body.eligible, false); assert.match(el.body.reason, /window/i);
  assert.equal((await request(app).post('/api/returns').set(A(tokens.asha)).send({ orderId: o.orderId, reason: 'Changed my mind' })).status, 400);
});
test('admin return workflow: strict order of steps, rejection needs a reason, restock once, then refund', async () => {
  const id = S.ret1; const go = (status, body = {}, t) => adm('put', `/returns/${id}/status`, { status, ...body }, t);
  const list = await adm('get', '/returns'); assert.equal(list.body.counts.REQUESTED, 2); assert.equal(list.body.returns[0].images, undefined); assert.equal(list.body.returns.find((r) => r.id === S.ret1).imageCount, 1, 'the list reports how many photos each return has');
  const detail = await adm('get', `/returns/${id}`); assert.equal(detail.body.images.length, 1); assert.deepEqual(detail.body.allowedNext, ['APPROVED', 'REJECTED']); assert.equal(detail.body.order.orderNumber, S.cod.orderNumber);
  assert.equal((await go('REFUND_PENDING')).status, 409, 'cannot skip review'); assert.equal((await go('REFUNDED')).status, 409, 'cannot jump to refunded'); assert.equal((await go('REJECTED')).status, 400, 'a rejection must give the customer a reason');
  assert.equal((await go('APPROVED')).status, 200); assert.equal((await go('APPROVED')).status, 409);
  assert.equal((await go('PICKUP_SCHEDULED', { pickup: { scheduledAt: '2026-10-06', courier: 'Delhivery', awb: 'RET1' } })).status, 200); assert.equal((await go('PICKED_UP')).status, 200); assert.equal((await go('RECEIVED')).status, 200); assert.equal((await go('INSPECTION')).status, 200);
  const stock = await stockOf(S.p1);
  assert.equal((await go('REFUND_PENDING', { inspection: { result: 'passed', notes: 'unused', restock: true } })).status, 200);
  assert.equal((await go('REFUNDED')).status, 400, 'marking refunded by hand is refused — the refund action does it'); assert.equal(await stockOf(S.p1), stock + 1, 'inspected item goes back into stock'); assert.equal((await M.StockMovement.find({ reason: 'return_restock' })).length >= 1, true);
  const r = await M.Return.findById(id); assert.equal(r.inspection.restocked, true); assert.equal(r.pickup.courier, 'Delhivery'); assert.deepEqual(r.history.map((h) => h.status), ['REQUESTED', 'APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'INSPECTION', 'REFUND_PENDING']);
  await wait(400); assert.equal(mails('asha@example.com', /Return approved/).length, 1); assert.equal(mails('asha@example.com', /pickup scheduled/i).length, 1);
  const rej = await adm('put', `/returns/${S.ret2}/status`, { status: 'REJECTED', rejectionReason: 'Item shows signs of use' }); assert.equal(rej.status, 200); await wait(300); assert.equal(mails('asha@example.com', /Return update/).length, 1);
  assert.equal((await request(app).get('/api/returns/mine').set(A(tokens.asha))).body.find((x) => x.id === S.ret2).journey.rejected, true);
});
test('COD return refund: needs a manual reference, owner-only, exactly once, order totals updated', async () => {
  const refund = (b, t) => adm('post', `/returns/${S.ret1}/refund`, b, t);
  assert.equal((await refund({ reference: 'UPI-1' }, tokens.staff)).status, 403, 'refunds are owner-only'); assert.equal((await refund({})).status, 400, 'COD refunds need a payout reference');
  assert.equal((await refund({ reference: 'UPI-1', amount: 99999 })).status, 400, 'cannot refund more than was paid');
  const ok = await refund({ reference: 'UPI-REF-77' }); assert.equal(ok.status, 200); assert.equal(ok.body.refund.method, 'manual'); assert.equal(ok.body.return.status, 'REFUNDED');
  const o = await M.Order.findById(S.cod.id); assert.equal(o.refundedAmount, 2499); assert.equal(o.refunds.length, 1); assert.equal(o.paymentStatus, 'Paid', 'a partial refund leaves the order paid');
  assert.equal((await refund({ reference: 'again' })).status, 409, 'a return can only be refunded once'); await wait(300); assert.equal(mails('asha@example.com', /Refund initiated/).length, 1);
  assert.equal((await adm('put', `/returns/${S.ret1}/status`, { status: 'CLOSED' })).status, 200);
});
test('online return refund goes through Razorpay; the return completes only when Razorpay confirms (webhook)', async () => {
  const o = await onlineOrder([[S.p1, 1]]); const pay = await payOnline(o); const oid = o.orderId;
  for (const s of ['Packed', 'Dispatched', 'Delivered']) assert.equal((await adm('put', `/orders/${oid}/status`, { orderStatus: s })).status, 200);
  const ot = await request(app).post('/api/customers/otp/send').send({ phone: '9812345678' }); const tok = (await request(app).post('/api/customers/otp/verify').send({ termsAccepted: true, phone: '9812345678', code: ot.body.devCode })).body.token;
  const rr = await request(app).post('/api/returns').set(A(tok)).send({ orderId: oid, reason: 'Wrong item received', resolution: 'Refund' }); assert.equal(rr.status, 201); assert.equal(rr.body.amount, o.total, 'full amount actually paid (after the prepaid discount)');
  for (const s of ['APPROVED', 'RECEIVED']) await adm('put', `/returns/${rr.body.id}/status`, { status: s });
  await adm('put', `/returns/${rr.body.id}/status`, { status: 'REFUND_PENDING', inspection: { result: 'passed', restock: false } });
  const before = rzRefunds.length; const rf = await adm('post', `/returns/${rr.body.id}/refund`, {}); assert.equal(rf.status, 200);
  assert.equal(rzRefunds.length, before + 1); const call = rzRefunds[before]; assert.equal(call.payment_id, pay); assert.equal(call.amount, o.total * 100, 'Razorpay is asked for paise'); assert.match(call.receipt, /^rf_FY\d{4}CL/);
  assert.equal(rf.body.refund.status, 'pending'); assert.equal(rf.body.return.status, 'REFUND_PENDING', 'not “refunded” until Razorpay says so'); const od = await M.Order.findById(oid); assert.equal(od.orderStatus, 'Refunded'); assert.equal(od.paymentStatus, 'Refunded');
  const ev = { refund: { entity: { id: rf.body.refund.refundId, payment_id: pay, amount: o.total * 100, status: 'processed' } } };
  assert.equal((await hook('refund.processed', ev, 'evt_rf1')).status, 200); assert.equal((await hook('refund.processed', ev, 'evt_rf1')).body.duplicate, true);
  const done = await M.Return.findById(rr.body.id); assert.equal(done.status, 'REFUNDED'); assert.equal(done.refund.status, 'processed'); assert.equal((await M.Order.findById(oid)).refunds[0].status, 'processed');
  await wait(400); assert.equal(mails('ravi@example.com', /Refund completed/).length, 1); assert.equal(mails('ravi@example.com', /Refund initiated/).length, 1);
  assert.equal((await adm('post', `/payments/orders/${oid}/refund`, { amount: 1 })).status, 400, 'nothing left to refund');
});
test('goodwill / partial refunds: guards, receipts, failure webhook restores the refundable amount', async () => {
  const o = await onlineOrder([[S.p1, 1]]); const pay = await payOnline(o); const url = `/payments/orders/${o.orderId}/refund`;
  assert.equal((await adm('post', url, { amount: 100 }, tokens.staff)).status, 403); for (const amount of [0, -5, 'abc', o.total + 1]) assert.equal((await adm('post', url, { amount })).status, 400, String(amount));
  const r1 = await adm('post', url, { amount: 500, reason: 'goodwill' }); assert.equal(r1.status, 200); assert.equal(r1.body.refundedAmount, 500); assert.equal(r1.body.paymentStatus, 'Paid');
  const r2 = await adm('post', url, { amount: o.total - 500, reason: 'rest' }); assert.equal(r2.body.paymentStatus, 'Refunded'); assert.equal((await adm('post', url, { amount: 1 })).status, 400);
  const fail = await hook('refund.failed', { refund: { entity: { id: r2.body.refund.refundId, payment_id: pay, amount: (o.total - 500) * 100, status: 'failed' } } }, 'evt_rf_fail'); assert.equal(fail.status, 200);
  const d = await M.Order.findById(o.orderId); assert.equal(d.refundedAmount, 500, 'a failed refund is un-counted so it can be retried'); assert.equal(d.paymentStatus, 'Paid');
  assert.equal((await adm('post', url, { amount: o.total - 500 })).status, 200, 'and can be issued again');
});

/* ================= delivery methods (admin-managed, multiple options, manual delivery) ================= */
test('delivery options: Standard is on by default; Express and Local delivery are off until the owner switches them on', async () => {
  const pub = await request(app).get('/api/delivery/options?pincode=600001&subtotal=2499'); assert.equal(pub.status, 200); assert.deepEqual(pub.body.options.map((o) => o.key), ['standard']); assert.equal(pub.body.options[0].fee, 0); assert.equal(pub.body.options[0].etaText, '5–7 days');
  const all = await adm('get', '/delivery'); assert.deepEqual(all.body.map((m) => [m.key, m.enabled, m.type]), [['standard', true, 'courier'], ['express', false, 'courier'], ['manual', false, 'manual']]);
  assert.equal((await adm('get', '/delivery', undefined, tokens.staff)).status, 200); assert.equal((await adm('put', '/delivery/manual', { enabled: true }, tokens.staff)).status, 403, 'only the owner can change delivery options');
  assert.equal((await request(app).get('/api/admin/delivery')).status, 401);
});
test('admin switches methods on/off and edits fee, free-above, ETA, COD, PIN area — guarded', async () => {
  const put = (k, b) => adm('put', '/delivery/' + k, b);
  assert.equal((await put('express', { enabled: true, fee: 149, etaMinDays: 2, etaMaxDays: 3, codAllowed: false })).status, 200);
  const m = await put('manual', { enabled: true, fee: 40, freeAbove: 3000, etaMinDays: 0, etaMaxDays: 1, pincodePrefixes: '600, 601', pincodes: '603110\n603111', description: 'Delivered by Rajan and team' }); assert.equal(m.status, 200); assert.deepEqual(m.body.pincodePrefixes, ['600', '601']); assert.deepEqual(m.body.pincodes, ['603110', '603111']);
  for (const bad of [{ fee: -1 }, { fee: 'abc' }, { etaMinDays: 9, etaMaxDays: 2 }, { pincodes: '12345' }, { pincodePrefixes: '1234567' }, { type: 'drone' }, { courierProvider: 'dhl' }, { name: '  ' }]) assert.equal((await put('manual', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await put('nope', { enabled: true })).status, 404);
  const opts = (q) => request(app).get('/api/delivery/options?' + q).then((r) => r.body.options);
  assert.deepEqual((await opts('pincode=600001&subtotal=2499')).map((o) => o.key), ['standard', 'express', 'manual']); assert.deepEqual((await opts('pincode=560001&subtotal=2499')).map((o) => o.key), ['standard', 'express'], 'local delivery only serves its own PIN area');
  assert.equal((await opts('pincode=603110&subtotal=2499')).some((o) => o.key === 'manual'), true, 'an exact PIN outside the prefixes works');
  const cod = await opts('pincode=600001&subtotal=2499&cod=1'); assert.deepEqual(cod.map((o) => [o.key, o.selectable]), [['standard', true], ['express', false], ['manual', true]]);
  assert.equal((await opts('pincode=600001&subtotal=3500')).find((o) => o.key === 'manual').fee, 0, 'free above ₹3000');
  const aud = await adm('get', '/audit?action=delivery'); assert.ok(aud.body.entries.some((e) => /switched ON/.test(e.summary)), 'switching a method on is audited');
});
test('cannot switch off the last delivery method; built-ins cannot be deleted; owners can add and remove custom ones', async () => {
  await adm('put', '/delivery/express', { enabled: false }); await adm('put', '/delivery/manual', { enabled: false });
  const last = await adm('put', '/delivery/standard', { enabled: false }); assert.equal(last.status, 400); assert.match(last.body.error, /at least one/i); assert.equal((await adm('delete', '/delivery/standard')).status, 400);
  const c = await adm('post', '/delivery', { name: 'Same-day Chennai', type: 'manual', fee: 99, etaMaxDays: 1, pincodePrefixes: '600', enabled: true }); assert.equal(c.status, 201); assert.equal(c.body.key, 'same-day-chennai'); assert.equal(c.body.isDefault, false);
  assert.equal((await adm('post', '/delivery', { name: 'Same-day Chennai', type: 'manual' })).body.key, 'same-day-chennai-2', 'duplicate names get a unique key'); await adm('delete', '/delivery/same-day-chennai-2');
  assert.equal((await adm('post', '/delivery', { name: '' })).status, 400); assert.equal((await adm('post', '/delivery', { name: 'x' }, tokens.staff)).status, 403);
  await adm('put', '/delivery/standard', { enabled: true }); assert.equal((await adm('put', '/delivery/standard', { enabled: false })).status, 200, 'with another method on, standard may go off'); await adm('put', '/delivery/standard', { enabled: true });
  assert.equal((await adm('delete', '/delivery/same-day-chennai')).status, 200); assert.equal((await adm('get', '/delivery')).body.some((m) => m.key === 'same-day-chennai'), false);
});
test('checkout: the chosen method is validated and priced on the server and frozen on the order', async () => {
  const p = await M.Product.create({ name: 'Small Shelf', slug: 'small-shelf', sku: 'SKU-SM', price: 1500, mrp: 1500, stock: 100 });
  await adm('put', '/delivery/standard', { fee: 99, freeAbove: 2000, etaMinDays: 5, etaMaxDays: 7 }); await adm('put', '/delivery/express', { enabled: true }); await adm('put', '/delivery/manual', { enabled: true });
  const buy = async (items, body) => place(await cartWith(items), { body });
  let r = await buy([[p, 1]], { deliveryMethod: 'standard' }); assert.equal(r.status, 201); assert.equal(r.body.total, 1500 + 99, 'ships for ₹99 under the free-shipping threshold');
  let o = await M.Order.findById(r.body.orderId); assert.equal(o.shipping, 99); assert.equal(o.delivery.method.key, 'standard'); assert.equal(o.delivery.method.fee, 99); assert.ok(o.estimatedDelivery > new Date(Date.now() + 6 * 86400e3));
  r = await buy([[p, 2]], { deliveryMethod: 'standard' }); assert.equal(r.body.total, 3000, 'free above ₹2000');
  r = await buy([[p, 1]], { deliveryMethod: 'express', paymentMethod: 'online' }); assert.equal(r.status, 201); assert.equal(r.body.total, 1500 - 75 + 149, 'prepaid 5% off the goods only; express fee on top, not discounted');
  r = await buy([[p, 1]], { deliveryMethod: 'express' }); assert.equal(r.status, 400); assert.match(r.body.error, /Cash on Delivery isn.t available with Express/);
  r = await buy([[p, 1]], { deliveryMethod: 'manual', address: { ...addr, pincode: '560001' } }); assert.equal(r.status, 400); assert.match(r.body.error, /isn.t available for PIN code 560001/);
  assert.equal((await buy([[p, 1]], { deliveryMethod: 'teleport' })).status, 400); assert.equal((await M.Product.findById(p.id)).reserved, 1, 'refused checkouts reserve no stock (the one reservation is the open online order)');
  await adm('put', '/delivery/express', { enabled: false }); r = await buy([[p, 1]], { deliveryMethod: 'express', paymentMethod: 'online' }); assert.equal(r.status, 400, 'a method that has been switched off can no longer be chosen');
  r = await buy([[p, 1]], {}); assert.equal(r.status, 201); assert.equal((await M.Order.findById(r.body.orderId)).delivery.method.key, 'standard', 'no choice sent = the first available method');
  await adm('put', '/delivery/standard', { enabled: false }); await adm('put', '/delivery/manual', { enabled: false }); const cc = await adm('put', '/delivery/manual', { enabled: true }); assert.equal(cc.status, 200);
  r = await buy([[p, 1]], { address: { ...addr, pincode: '560001' } }); assert.equal(r.status, 400, 'no method serves this PIN'); await adm('put', '/delivery/standard', { enabled: true, fee: 0, freeAbove: 0 });
  await adm('put', '/delivery/standard', { fee: 99 }); await adm('put', '/delivery/standard', { fee: 0 }); const past = await M.Order.findById(o.id); assert.equal(past.delivery.method.fee, 99, 'editing a method never changes past orders');
});
test('MANUAL delivery order: no courier booked, own delivery person assigned, customer told who is coming, COD collected', async () => {
  await adm('put', '/delivery/manual', { enabled: true, fee: 40, freeAbove: 0, etaMaxDays: 1, pincodePrefixes: '600' }); courier.calls.length = 0;
  const r = await place(await cartWith([[S.p1, 1]]), { body: { deliveryMethod: 'manual' } }); assert.equal(r.status, 201); assert.equal(r.body.total, 2499 + 40); const id = r.body.orderId; const num = r.body.orderNumber;
  const ship = await adm('post', `/orders/${id}/shipment`, {}); assert.equal(ship.status, 409); assert.match(ship.body.error, /manual delivery/i); assert.equal(courier.calls.length, 0, 'the courier API was never called');
  assert.equal((await adm('put', `/orders/${id}/delivery`, { assignee: { name: '  ', phone: '' } })).status, 400, 'a delivery person needs a name');
  const as = await adm('put', `/orders/${id}/delivery`, { assignee: { name: 'Rajan', phone: '+91 90000 00009' }, scheduledFor: '2026-10-06T10:30:00Z', notes: 'Call before arriving' }); assert.equal(as.status, 200);
  const d = await M.Order.findById(id); assert.equal(d.delivery.method.key, 'manual', 'saving delivery details keeps the chosen method'); assert.equal(d.delivery.assignee.phone, '+919000000009'); assert.equal(d.estimatedDelivery.toISOString().slice(0, 10), '2026-10-06');
  const t1 = await request(app).get(`/api/track?orderNumber=${num}&email=asha@example.com`); assert.equal(t1.body.journey.courier.name, 'Our delivery team'); assert.equal(t1.body.journey.courier.awb, ''); assert.deepEqual(t1.body.journey.assignee, { name: 'Rajan', phone: '' });
  for (const st of ['Packed', 'Dispatched']) assert.equal((await adm('put', `/orders/${id}/status`, { orderStatus: st })).status, 200);
  assert.equal((await adm('put', `/orders/${id}/status`, { orderStatus: 'OutForDelivery' })).status, 200); await wait(400);
  const labels = (await M.Order.findById(id)).events.filter((e) => e.public).map((e) => e.label); assert.ok(labels.includes('Handed to our delivery team') && labels.includes('Packed and ready for delivery') && !labels.some((l) => /courier/i.test(l)), 'a manual delivery timeline never mentions a courier: ' + labels.join(' | '));
  const out = mails('asha@example.com', /Out for delivery/).filter((e) => e.html.includes(num)).pop(); assert.ok(out, 'out-for-delivery email sent'); assert.match(out.html, /with Rajan/); assert.match(out.html, /\+919000000009/); assert.ok(!/AWB|courier/i.test(out.html));
  const t2 = await request(app).get(`/api/track?orderNumber=${num}&email=asha@example.com`); assert.equal(t2.body.journey.assignee.phone, '+919000000009', 'phone visible once the order is out'); assert.match(t2.body.journey.headline, /Out for delivery/);
  assert.equal((await adm('put', `/orders/${id}/status`, { orderStatus: 'Delivered' })).status, 200); const done = await M.Order.findById(id); assert.equal(done.paymentStatus, 'Paid', 'cash collected by our team'); assert.equal(done.total, 2539);
  const lst = await adm('get', '/orders?q=' + num); assert.equal(lst.body.orders[0].delivery.method, 'Local delivery by our team'); assert.equal(lst.body.orders[0].delivery.assignee, 'Rajan');
  await adm('put', '/delivery/manual', { enabled: false });
});
test('with the courier method, auto-shipment still works; with manual it is skipped', async () => {
  await request(app).put('/api/admin/settings').set(A(tokens.owner)).send({ autoCreateShipment: true, defaultCourierProvider: 'shiprocket' });
  const i = await adm('put', '/integrations/shiprocket', { enabled: true, secrets: { email: 'ops@shop.test', password: 'pw-123456' }, config: { pickupLocation: 'Primary' } }); assert.equal(i.status, 200);
  assert.ok(!JSON.stringify(i.body).includes('pw-123456') && !JSON.stringify(i.body).includes('secretsEnc'), 'secrets never come back'); assert.match(JSON.stringify(i.body.secretHints), /••••/);
  const raw = await M.Integration.findOne({ provider: 'shiprocket' }); assert.ok(!raw.secretsEnc.includes('pw-123456'), 'encrypted at rest');
  courier.calls.length = 0; const r = await place(await cartWith([[S.p1, 1]]), { body: { deliveryMethod: 'standard' } }); await wait(900);
  const o = await M.Order.findById(r.body.orderId); assert.match(o.shipment.awb, /^AWB/, 'booked automatically with the courier'); assert.equal(o.shipment.courierName, 'Delhivery'); assert.equal(o.delivery.trackingId, o.shipment.awb);
  await adm('put', '/delivery/manual', { enabled: true }); courier.calls.length = 0; const m = await place(await cartWith([[S.p1, 1]]), { body: { deliveryMethod: 'manual' } }); await wait(700);
  assert.equal((await M.Order.findById(m.body.orderId)).shipment.awb, '', 'manual orders are never auto-booked'); assert.equal(courier.calls.length, 0);
  await adm('put', '/delivery/manual', { enabled: false }); await request(app).put('/api/admin/settings').set(A(tokens.owner)).send({ autoCreateShipment: false });
});

/* ================= courier shipments (mock Shiprocket) ================= */
async function paidCod(extra = {}) { const r = await place(await cartWith([[S.p1, 1]]), { body: { deliveryMethod: 'standard', ...extra } }); assert.equal(r.status, 201); return r.body; }
test('shipment: partial failure is COMPLETED on retry — the courier order is never duplicated', async () => {
  const o = await paidCod(); courier.calls.length = 0; courier.awbFails = true;
  const a = await adm('post', `/orders/${o.orderId}/shipment`, {}); assert.equal(a.status, 201); assert.equal(a.body.shipment.awb, ''); assert.match(a.body.shipment.error, /AWB.*No courier serviceable/); assert.ok(a.body.shipment.shipmentId);
  assert.equal(courier.calls.filter((u) => u === '/orders/create/adhoc').length, 1);
  courier.awbFails = false; courier.calls.length = 0;
  const b = await adm('post', `/orders/${o.orderId}/shipment`, {}); assert.equal(b.status, 201); assert.match(b.body.shipment.awb, /^AWB/); assert.equal(b.body.shipment.status, 'pickup_scheduled'); assert.equal(b.body.shipment.labelUrl, 'https://labels.test/1.pdf');
  assert.equal(courier.calls.filter((u) => u === '/orders/create/adhoc').length, 0, 'the retry did NOT create a second courier order'); assert.equal(b.body.shipment.shipmentId, a.body.shipment.shipmentId);
  assert.equal((await adm('post', `/orders/${o.orderId}/shipment`, {})).status, 409, 'cannot book twice'); assert.equal((await M.AuditLog.countDocuments({ action: 'shipment.created', entityId: o.orderId })), 2); S.shipOrder = o;
});
test('tracking sync moves the order forward, notifies the customer, and collects COD on delivery', async () => {
  const id = S.shipOrder.orderId; const sync = () => adm('post', `/orders/${id}/shipment/sync`, {});
  await adm('put', `/orders/${id}/status`, { orderStatus: 'Packed' });
  courier.track = 'Picked Up'; assert.equal((await sync()).body.status, 'Dispatched'); courier.track = 'Out For Delivery'; assert.equal((await sync()).body.status, 'OutForDelivery'); assert.equal((await sync()).body.changed, false, 'same status again changes nothing');
  courier.track = 'In Transit'; assert.equal((await sync()).body.status, 'OutForDelivery', 'never goes backwards'); courier.track = 'Delivered'; assert.equal((await sync()).body.status, 'Delivered');
  const o = await M.Order.findById(id); assert.equal(o.paymentStatus, 'Paid'); assert.ok(o.deliveredAt); assert.equal(o.estimatedDelivery.toISOString().slice(0, 10), '2026-10-09'); assert.ok(o.events.some((e) => e.location === 'Chennai Hub'));
  await wait(400); assert.equal(mails('asha@example.com', /Delivered/).filter((e) => e.html.includes(o.orderNumber)).length, 1, 'one delivered email, not one per sync');
  const t = await request(app).get(`/api/track?orderNumber=${o.orderNumber}&email=asha@example.com`); assert.equal(t.body.journey.courier.name, 'Delhivery'); assert.match(t.body.journey.courier.awb, /^AWB/); assert.ok(t.body.journey.courier.trackingUrl);
  assert.equal((await adm('post', `/orders/${S.cod.id}/shipment/sync`, {})).status, 400, 'an order without a courier shipment cannot be synced');
});
test('courier webhook: token required, duplicates ignored, unknown AWB ignored; cancel only before pickup', async () => {
  const o = await paidCod(); await adm('post', `/orders/${o.orderId}/shipment`, {}); const awb = (await M.Order.findById(o.orderId)).shipment.awb;
  const token = (await adm('get', '/integrations')).body.providers.find((p) => p.id === 'shiprocket').saved.webhookToken; assert.ok(token);
  const hit = (b, t) => request(app).post('/api/webhooks/courier/shiprocket' + (t ? '?token=' + t : '')).send(b);
  assert.equal((await hit({ awb, current_status: 'IN TRANSIT' })).status, 401); assert.equal((await hit({ awb, current_status: 'IN TRANSIT' }, 'wrong')).status, 401);
  await adm('put', `/orders/${o.orderId}/status`, { orderStatus: 'Packed' }); const body = { awb, current_status: 'IN TRANSIT', location: 'Hub', current_timestamp: '2026-10-07 10:00:00' };
  assert.equal((await hit(body, token)).status, 200); assert.equal((await M.Order.findById(o.orderId)).orderStatus, 'InTransit'); assert.equal((await hit(body, token)).body.duplicate, true);
  assert.equal((await hit({ awb: 'NOPE', current_status: 'DELIVERED' }, token)).status, 200); assert.equal((await M.WebhookEvent.findOne({ provider: 'shiprocket', status: 'ignored' })) != null, true);
  const c = await paidCod(); await adm('post', `/orders/${c.orderId}/shipment`, {}); assert.equal((await adm('delete', `/orders/${c.orderId}/shipment`)).status, 200); const cd = await M.Order.findById(c.orderId); assert.equal(cd.shipment.status, 'cancelled'); assert.equal(cd.shipment.awb, '');
  assert.equal((await adm('delete', `/orders/${o.orderId}/shipment`)).status, 409, 'once the parcel has left it cannot be cancelled here');
  const again = await adm('post', `/orders/${c.orderId}/shipment`, {}); assert.equal(again.status, 201, 'a cancelled shipment can be re-booked');
});
test('courier outage never damages the order: error is recorded for the admin, payment and status untouched', async () => {
  const o = await paidCod(); courier.down = true; const r = await adm('post', `/orders/${o.orderId}/shipment`, {}); courier.down = false; assert.ok(r.status >= 400);
  const d = await M.Order.findById(o.orderId); assert.match(d.shipment.error, /unavailable/i); assert.equal(d.orderStatus, 'Processing'); assert.equal(d.shipment.attempts, 1); assert.ok(d.events.some((e) => e.type === 'shipment_error' && e.public === false), 'internal note only');
  assert.equal((await adm('post', `/orders/${o.orderId}/shipment`, {})).status, 201, 'retry works once the courier is back');
  assert.equal((await adm('post', '/integrations/shiprocket/test', {})).body.ok, true); assert.equal((await adm('post', '/integrations/shiprocket/test', {}, tokens.staff)).status, 403);
  assert.equal((await adm('put', '/integrations/msg91', { enabled: true }, tokens.owner)).status, 400, 'cannot enable an integration without credentials'); assert.equal((await adm('put', '/integrations/shiprocket', { enabled: true }, tokens.staff)).status, 403);
  const health = await adm('get', '/system/health'); assert.equal(health.status, 200); assert.equal(health.body.config.courierEnabled, true); assert.equal(health.body.config.secretsStorageReady, true);
});

/* ================= purchase orders, inventory, analytics, audit ================= */
test('purchase orders: flow, receiving updates stock + ledger, invoice must be verified before paying, payment limits', async () => {
  const sup = await M.Supplier.create({ name: 'Kerala Woodworks', contactPerson: 'Rajan', phone: '9876500000', email: 'k@w.com' });
  const po = (b, t) => adm('post', '/purchase-orders', b, t); const items = [{ description: 'Row Rack', productId: S.p2.id, qty: 10, unitCost: 600 }, { description: 'Packaging', qty: 10, unitCost: 50 }];
  assert.equal((await po({ supplierId: sup.id, items: [] })).status, 400); assert.equal((await po({ supplierId: sup.id, items: [{ description: 'x', qty: 0, unitCost: 1 }] })).status, 400); assert.equal((await po({ supplierId: '64b000000000000000000000', items })).status, 400);
  const c = await po({ supplierId: sup.id, items, expectedDate: '2026-10-20' }); assert.equal(c.status, 201); assert.match(c.body.poNumber, /^PO-\d+$/); assert.equal(c.body.total, 6500); assert.equal(c.body.status, 'Draft'); const id = c.body.id;
  assert.equal((await adm('post', `/purchase-orders/${id}/receive`, { lines: [] })).status, 409, 'cannot receive goods on a draft'); for (const st of ['Sent', 'Confirmed']) assert.equal((await adm('put', `/purchase-orders/${id}/status`, { status: st })).status, 200);
  assert.equal((await adm('put', `/purchase-orders/${id}/status`, { status: 'Draft' })).status, 409);
  const before = await stockOf(S.p2); const full = (await adm('get', `/purchase-orders/${id}`)).body; const [l1, l2] = full.items;
  assert.equal((await adm('post', `/purchase-orders/${id}/receive`, { lines: [{ itemId: l1.id || l1._id, qty: 11 }] })).status, 400, 'cannot receive more than ordered');
  const rc = await adm('post', `/purchase-orders/${id}/receive`, { lines: [{ itemId: l1._id || l1.id, qty: 4 }] }); assert.equal(rc.status, 200); assert.equal(rc.body.status, 'PartiallyReceived'); assert.equal(await stockOf(S.p2), before + 4);
  assert.ok(await M.StockMovement.findOne({ reason: 'po_received', ref: full.poNumber, delta: 4 })); assert.equal((await adm('put', `/purchase-orders/${id}/status`, { status: 'Cancelled' })).status, 409, 'goods already received');
  const pay = (b, t) => adm('post', `/purchase-orders/${id}/payments`, b, t);
  assert.equal((await pay({ amount: 100 })).status, 409, 'no payment before the invoice is verified'); assert.equal((await adm('post', `/purchase-orders/${id}/invoice/verify`, {})).status, 400);
  assert.equal((await adm('put', `/purchase-orders/${id}/invoice`, { number: '', amount: 5 })).status, 400); const inv = await adm('put', `/purchase-orders/${id}/invoice`, { number: 'KW/23/118', amount: 6000, date: '2026-10-10', file: jpeg }); assert.equal(inv.status, 200);
  assert.equal((await adm('post', `/purchase-orders/${id}/invoice/verify`, {}, tokens.staff)).status, 403); assert.equal((await adm('post', `/purchase-orders/${id}/invoice/verify`, {})).status, 200); assert.equal((await adm('put', `/purchase-orders/${id}/invoice`, { number: 'X', amount: 1 })).status, 409, 'a verified invoice is locked');
  assert.equal((await pay({ amount: 100 }, tokens.staff)).status, 403, 'only the owner records supplier payments'); assert.equal((await pay({ amount: 6001 })).status, 400, 'more than outstanding'); assert.equal((await pay({ amount: 0 })).status, 400);
  let p = await pay({ amount: 2500, method: 'bank_transfer', reference: 'NEFT123' }); assert.equal(p.status, 201); assert.equal(p.body.paymentStatus, 'PartiallyPaid'); assert.equal(p.body.outstanding, 3500); assert.equal(p.body.payable, 6000, 'the verified invoice amount is what is owed');
  p = await pay({ amount: 3500 }); assert.equal(p.body.paymentStatus, 'Paid'); assert.equal(p.body.outstanding, 0); assert.equal((await pay({ amount: 1 })).status, 400);
  const sum = await adm('get', '/purchase-orders/summary'); assert.equal(sum.body.totals.outstanding, 0); assert.equal(sum.body.bySupplier[0].supplier, 'Kerala Woodworks'); assert.equal(sum.body.bySupplier[0].paid, 6000);
  assert.equal((await adm('get', '/purchase-orders?pay=Paid')).body.total, 1); assert.equal((await adm('get', `/purchase-orders/${id}/invoice-file`)).body.file, jpeg);
});
test('inventory: ledger, guarded manual adjustments, product edits are recorded', async () => {
  const inv = await adm('get', '/inventory'); const row = inv.body.items.find((i) => i.sku === 'SKU2'); assert.ok(row); assert.equal(row.available, row.stock - row.reserved); assert.equal(inv.body.totals.problems, 0, 'no inventory inconsistencies after all those orders, refunds and cancellations');
  const adjust = (b, t) => adm('post', '/inventory/adjust', { productId: S.p2.id, ...b }, t); const st = await stockOf(S.p2);
  assert.equal((await adjust({ delta: 0, reason: 'x' })).status, 400); assert.equal((await adjust({ delta: 5 })).status, 400, 'a reason is mandatory'); assert.equal((await adjust({ delta: -99999, reason: 'oops' })).status, 409, 'cannot remove more than exists');
  assert.equal((await adjust({ delta: -2, reason: 'Damaged in storage', note: 'water leak' }, tokens.staff)).status, 200); assert.equal(await stockOf(S.p2), st - 2);
  const mv = await adm('get', '/inventory/movements?product=' + S.p2.id); assert.equal(mv.body.movements[0].reason, 'manual_adjustment'); assert.match(mv.body.movements[0].note, /Damaged in storage — water leak/); assert.equal(mv.body.movements[0].actor, 'staff@shop.test');
  const put = await adm('put', '/products/' + S.p2.id, { stock: st + 10, price: 1600 }); assert.equal(put.status, 200); assert.equal(put.body.stock, st + 10); assert.equal((await adm('get', '/inventory/movements?product=' + S.p2.id)).body.movements[0].delta, 12, 'editing stock in Products is also in the ledger');
  assert.ok((await M.AuditLog.findOne({ action: 'product.updated', entityId: S.p2.id })).before.price === 1500); await adm('put', '/products/' + S.p2.id, { price: 1500 });
  assert.equal((await adm('post', '/products', { name: 'New Thing', slug: 'new-thing', sku: 'SKU-N', price: 10, mrp: 10, stock: 7 })).body.stock, 7); assert.ok(await M.StockMovement.findOne({ reason: 'initial_stock', delta: 7 }));
});
test('analytics: ranges, revenue/refunds, sources, couriers; bad ranges refused', async () => {
  const a = await adm('get', '/analytics?range=30d'); assert.equal(a.status, 200); assert.ok(a.body.revenue > 0); assert.ok(a.body.orders.placed >= a.body.orders.paid); assert.ok(a.body.refundAmount > 0, 'refunds issued earlier in this run are counted'); assert.equal(a.body.netRevenue, a.body.revenue - a.body.refundAmount);
  assert.ok(a.body.sources.some((x) => x.source === 'instagram')); assert.ok(a.body.sources.some((x) => x.source === 'direct')); assert.ok(a.body.couriers.some((c) => c.name === 'Delhivery')); assert.equal(a.body.daily.length, 30); assert.ok(a.body.returns.count >= 2); assert.ok(a.body.products.length >= 2); assert.equal(a.body.conversion, null);
  assert.equal((await adm('get', '/analytics?range=today')).body.daily.length, 1); assert.equal((await adm('get', '/analytics?range=custom&from=2026-01-01&to=2026-12-31')).status, 200); assert.equal((await adm('get', '/analytics?range=custom&from=2026-12-31&to=2026-01-01')).status, 400); assert.equal((await adm('get', '/analytics?range=custom&from=2020-01-01&to=2026-12-31')).status, 400);
});
test('audit log: who / what / before / after; owner-only', async () => {
  const log = await adm('get', '/audit?limit=200'); assert.equal(log.status, 200); const acts = new Set(log.body.entries.map((e) => e.action));
  for (const a of ['order.status_changed', 'refund.issued', 'settings.updated', 'shipment.created', 'integration.updated', 'return.status_changed', 'po.payment_recorded', 'inventory.adjusted', 'delivery.updated', 'admin.login']) assert.ok(acts.has(a), a);
  const e = log.body.entries.find((x) => x.action === 'order.status_changed'); assert.ok(e.actor.includes('@') && e.entityId && e.before.status && e.after.status && e.summary); const r = log.body.entries.find((x) => x.action === 'refund.issued'); assert.match(r.summary, /Refunded Order FY\d{4}CL\d+ — ₹\d+/);
  const st = log.body.entries.find((x) => x.action === 'settings.updated'); assert.ok(st.before && st.after);
  assert.ok(!JSON.stringify(log.body).includes('pw-123456') && !JSON.stringify(log.body).includes('secretsEnc'), 'secrets never reach the audit log'); assert.equal((await adm('get', '/audit', undefined, tokens.staff)).status, 403);
  assert.ok((await adm('get', '/audit?q=Refunded')).body.entries.every((x) => /Refund/i.test(x.summary + x.actor)));
});
test('admin login lockout after repeated failures; notification failures are logged and retried', async () => {
  const a = new M.Admin({ name: 'Lock', email: 'lock@shop.test', role: 'STAFF' }); await a.setPassword('Passw0rd!x'); await a.save();
  const login = (pw) => request(app).post('/api/auth/login').send({ email: 'lock@shop.test', password: pw });
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401); const locked = await login('Passw0rd!x'); assert.equal(locked.status, 423, 'locked even with the right password'); assert.match(locked.body.error, /locked/i);
  await M.Admin.collection.updateOne({ email: 'lock@shop.test' }, { $set: { lockUntil: new Date(Date.now() - 1000) } }); assert.equal((await login('Passw0rd!x')).status, 200, 'works again after the lock expires'); assert.equal((await request(app).post('/api/auth/login').send({ email: 'nobody@shop.test', password: 'x' })).status, 401);
  const realFetchLocal = globalThis.fetch; const stash = globalThis.fetch; globalThis.fetch = async (u, i) => (String(u).includes('api.resend.com') ? { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) } : stash(u, i));
  const { resetNotifierCache } = require('../src/services/notifier'); resetNotifierCache(); const o = await paidCod(); await wait(500); globalThis.fetch = stash;
  const failed = await adm('get', '/notification-log?status=failed'); assert.ok(failed.body.logs.some((l) => l.orderNumber === o.orderNumber && l.channel === 'email'), 'the failed send is visible to the admin'); const dash = await adm('get', '/system/health'); assert.ok(dash.body.problems.failedNotifications >= 1);
  const retry = await adm('post', '/notification-log/retry', {}); assert.ok(retry.body.sent >= 1); assert.equal((await adm('get', '/notification-log?status=failed')).body.logs.filter((l) => l.orderNumber === o.orderNumber).length, 0, 'retry delivered it');
});
test('admin customers: paginated with spend stats; block is owner-only', async () => {
  const l = await adm('get', '/customers?limit=2&page=1'); assert.equal(l.status, 200); assert.equal(l.body.customers.length <= 2, true); const asha = (await adm('get', '/customers?q=9876543210')).body.customers[0]; assert.ok(asha.orderCount >= 2, 'open COD orders count as orders'); assert.equal(typeof asha.totalSpend, 'number'); assert.ok(asha.lastOrderAt === null || asha.lastOrderAt);
  assert.equal((await adm('put', `/customers/${asha.id}/status`, { status: 'blocked' }, tokens.staff)).status, 403); assert.equal((await adm('put', `/customers/${asha.id}/status`, { status: 'weird' })).status, 400);
  const d = await adm('get', `/customers/${asha.id}`); assert.ok(d.body.orders.length >= 3);
});

test('admin passwords: change needs the current one, weak ones refused, old one stops working; reset script recovers a forgotten password and unlocks', async () => {
  const a = new M.Admin({ name: 'Pw', email: 'pw@shop.test', role: 'ADMIN' }); await a.setPassword('Original-pass-2026'); await a.save();
  const app2 = require('../src/app').createApp(); // own instance = own rate-limit counters (the shared one has seen many logins)
  const login = (pw) => request(app2).post('/api/auth/login').send({ email: 'pw@shop.test', password: pw }); const tok = (await login('Original-pass-2026')).body.token;
  const put = (b, t = tok) => request(app2).put('/api/auth/password').set(A(t)).send(b);
  assert.equal((await request(app2).put('/api/auth/password').send({})).status, 401);
  assert.equal((await put({ currentPassword: 'wrong', newPassword: 'Brand-new-pass-2027' })).status, 400); assert.equal((await put({ currentPassword: 'Original-pass-2026', newPassword: 'short1' })).status, 400);
  assert.equal((await put({ currentPassword: 'Original-pass-2026', newPassword: 'Original-pass-2026' })).status, 400); assert.equal((await put({ currentPassword: { $ne: 1 }, newPassword: 'x' })).status, 400);
  assert.equal((await put({ currentPassword: 'Original-pass-2026', newPassword: 'Brand-new-pass-2027' })).body.changed, true);
  assert.equal((await login('Original-pass-2026')).status, 401, 'the old password stops working'); assert.equal((await login('Brand-new-pass-2027')).status, 200);
  assert.ok(await M.AuditLog.findOne({ action: 'admin.password_changed', actor: 'pw@shop.test' })); assert.ok(!JSON.stringify(await M.AuditLog.find({ action: /password/ })).includes('Brand-new'), 'passwords never reach the audit log');
  // forgotten password: lock the account, then recover it with the shell script
  for (let i = 0; i < 5; i++) await login('nope'); assert.equal((await login('Brand-new-pass-2027')).status, 423);
  const { spawnSync } = require('child_process'); const env = { ...process.env, ADMIN_EMAIL: 'PW@shop.test', NEW_PASSWORD: 'Recovered-passphrase-77', MONGODB_URI: process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27018/craftlab_test' };
  const weak = spawnSync('node', ['scripts/reset-admin.js'], { env: { ...env, NEW_PASSWORD: 'weak' }, encoding: 'utf8' }); assert.notEqual(weak.status, 0); assert.match(weak.stderr, /12 characters/);
  const unknown = spawnSync('node', ['scripts/reset-admin.js'], { env: { ...env, ADMIN_EMAIL: 'ghost@shop.test' }, encoding: 'utf8' }); assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /No admin with email/);
  const ok = spawnSync('node', ['scripts/reset-admin.js'], { env, encoding: 'utf8' }); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /Account unlocked/); assert.ok(!ok.stdout.includes('Recovered-passphrase-77'), 'the script never prints the password');
  assert.equal((await login('Recovered-passphrase-77')).status, 200, 'the reset password works and the lock is cleared'); assert.equal((await login('Brand-new-pass-2027')).status, 401);
  const list = spawnSync('node', ['scripts/reset-admin.js'], { env: { ...env, ADMIN_EMAIL: '' }, encoding: 'utf8' }); assert.match(list.stdout, /pw@shop\.test\s+\(ADMIN\)/); assert.ok(!/\$2[aby]\$/.test(list.stdout), 'listing never shows hashes');
  assert.ok(await M.AuditLog.findOne({ action: 'admin.password_reset' }));
});

/* ================= email OTP (free) + verified-contact ownership ================= */
test('EMAIL OTP via the test provider: login by email, account auto-created and email-verified, no duplicate, wrong channel input refused', async () => {
  const appO = require('../src/app').createApp();
  const set = (b) => request(app).put('/api/admin/settings').set(A(tokens.owner)).send(b); await set({ otpEnabled: true, otpProvider: 'dev', otpChannel: 'email', customerLoginEnabled: true, customerSignupEnabled: true, autoCreateAccounts: true });
  const cfg = (await request(app).get('/api/config/public')).body.auth; assert.equal(cfg.otpChannel, 'email'); assert.equal((await request(app).get('/api/customers/auth-options')).body.otpChannel, 'email');
  await clearOtpCooldown(); assert.equal((await request(appO).post('/api/customers/otp/send').send({ phone: '9876543210' })).status, 400, 'a phone number is not accepted when OTP is by email');
  const s1 = await request(appO).post('/api/customers/otp/send').send({ email: 'Priya.N@Example.com' }); assert.equal(s1.status, 200); assert.equal(s1.body.channel, 'email'); assert.equal(s1.body.identifier, 'priya.n@example.com');
  const v = await request(appO).post('/api/customers/otp/verify').send({ termsAccepted: true, email: 'priya.n@example.com', code: s1.body.devCode, name: 'Priya N' }); assert.equal(v.status, 200); assert.equal(v.body.isNewCustomer, true); assert.equal(v.body.customer.email, 'priya.n@example.com'); assert.equal(v.body.customer.emailVerified, true); assert.equal(v.body.customer.phoneVerified, false); assert.ok(!v.body.customer.phone);
  tokens.priya = v.body.token; await clearOtpCooldown(); const s2 = await request(appO).post('/api/customers/otp/send').send({ email: 'priya.n@example.com' }); const again = await request(appO).post('/api/customers/otp/verify').send({ termsAccepted: true, email: 'PRIYA.N@example.com', code: s2.body.devCode });
  assert.equal(again.body.isNewCustomer, false); assert.equal(await M.Customer.countDocuments({ email: 'priya.n@example.com' }), 1);
  // an existing email+password customer becomes verified by OTP too
  const pw = new M.Customer({ name: 'Pw Customer', email: 'pwuser@example.com' }); await pw.setPassword('long-enough-1'); await pw.save(); await clearOtpCooldown();
  const s3 = await request(appO).post('/api/customers/otp/send').send({ email: 'pwuser@example.com' }); assert.equal((await request(appO).post('/api/customers/otp/verify').send({ termsAccepted: true, email: 'pwuser@example.com', code: s3.body.devCode })).body.customer.emailVerified, true);
});
test('EMAIL OTP via Brevo and ZeptoMail: credentials encrypted, the real request shape is sent, test button works, codes verify', async () => {
  const appO = require('../src/app').createApp();
  const save = (id, b) => adm('put', '/integrations/' + id, b);
  const bad = await save('brevo', { enabled: true, secrets: { apiKey: 'xkeysib-secret-123' }, config: { senderEmail: 'care@shop.test', senderName: 'Shop' } }); assert.equal(bad.status, 200); assert.ok(!JSON.stringify(bad.body).includes('xkeysib'), 'API key never returned'); assert.ok(!(await M.Integration.findOne({ provider: 'brevo' })).secretsEnc.includes('xkeysib'), 'encrypted at rest');
  assert.equal((await adm('post', '/integrations/brevo/test', {})).status, 400, 'a test needs an address to email'); const t = await adm('post', '/integrations/brevo/test', { email: 'me@example.com' }); assert.equal(t.body.ok, true); assert.equal(otpMails.at(-1).body.to[0].email, 'me@example.com');
  await adm('put', '/settings', { otpProvider: 'brevo', otpChannel: 'sms' }); await clearOtpCooldown(); otpMails.length = 0;
  assert.equal((await request(app).get('/api/config/public')).body.auth.otpChannel, 'email', 'Brevo means email, whatever the dev-channel setting says');
  const s = await request(appO).post('/api/customers/otp/send').send({ email: 'buyer@example.com' }); assert.equal(s.status, 200); assert.equal(s.body.devCode, undefined, 'the code is never returned by a real provider');
  const mail = otpMails.at(-1); assert.equal(mail.url, 'https://api.brevo.com/v3/smtp/email'); assert.equal(mail.headers['api-key'], 'xkeysib-secret-123'); assert.equal(mail.body.sender.email, 'care@shop.test'); const code = mail.body.subject.match(/^(\d{6})/)[1];
  assert.equal((await request(appO).post('/api/customers/otp/verify').send({ termsAccepted: true, email: 'buyer@example.com', code })).status, 200);
  await save('zeptomail', { enabled: true, secrets: { sendMailToken: 'zepto-token-xyz' }, config: { senderEmail: 'care@shop.test', region: 'in' } }); await adm('put', '/settings', { otpProvider: 'zeptomail' }); await clearOtpCooldown(); otpMails.length = 0;
  assert.equal((await request(appO).post('/api/customers/otp/send').send({ email: 'z@example.com' })).status, 200); const z = otpMails.at(-1); assert.equal(z.url, 'https://api.zeptomail.in/v1.1/email'); assert.equal(z.headers.Authorization, 'Zoho-enczapikey zepto-token-xyz'); assert.equal(z.body.to[0].email_address.address, 'z@example.com');
  await adm('put', '/integrations/zeptomail', { enabled: false }); await clearOtpCooldown(); assert.equal((await request(appO).post('/api/customers/otp/send').send({ email: 'z2@example.com' })).status, 503, 'a provider switched off cannot send');
  await adm('put', '/settings', { otpProvider: 'dev', otpChannel: 'sms' });
});
test('mandatory verification with EMAIL OTP: guests and unverified accounts refused; the verified email is the one used on the order', async () => {
  await adm('put', '/settings', { otpProvider: 'dev', otpChannel: 'email', requireMobileVerification: true });
  const c1 = await cartWith([[S.p1, 1]]); const g = await place(c1); assert.equal(g.status, 401); assert.match(g.body.error, /verify your email/);
  const unv = await request(app).post('/api/customers/signup').send({ termsAccepted: true, name: 'Unverified', email: 'unv@example.com', password: 'long-enough-1' }); assert.equal((await place(c1, { auth: unv.body.token })).status, 401, 'an account that never verified its email is not enough');
  const r = await place(c1, { auth: tokens.priya, body: { customer: { name: 'Priya N', phone: '9444444444', email: 'someoneelse@example.com' } } }); assert.equal(r.status, 201, JSON.stringify(r.body)); const o = await M.Order.findById(r.body.orderId);
  assert.equal(o.customer.email, 'priya.n@example.com', 'the VERIFIED email replaces whatever the browser sent'); assert.equal(o.customer.phone, '+919444444444', 'the phone is just the delivery contact in email mode'); assert.equal(String(o.customerId), String((await M.Customer.findOne({ email: 'priya.n@example.com' })).id));
  const mine = await request(app).get('/api/customers/me/orders').set(A(tokens.priya)); assert.ok(mine.body.some((x) => x.orderNumber === o.orderNumber));
  await adm('put', '/settings', { requireMobileVerification: false, otpProvider: 'dev', otpChannel: 'sms' });
});
test('PRIVACY: guest orders are shown only through a VERIFIED phone/email — typing someone’s number at sign-up reveals nothing', async () => {
  const appO = require('../src/app').createApp();
  const g = await place(await cartWith([[S.p1, 1]]), { body: { customer: { name: 'Guest Victim', phone: '9333333333', email: 'victim@example.com' } } }); assert.equal(g.status, 201); const num = g.body.orderNumber;
  const att = await request(app).post('/api/customers/signup').send({ termsAccepted: true, name: 'Attacker', email: 'attacker@example.com', phone: '9333333333', password: 'long-enough-1' }); assert.equal(att.status, 201);
  const mine = await request(app).get('/api/customers/me/orders').set(A(att.body.token)); assert.ok(!mine.body.some((o) => o.orderNumber === num), 'an unverified phone gives no access to guest orders'); assert.equal((await request(app).get('/api/customers/me/updates').set(A(att.body.token))).body.length, 0);
  await M.Order.collection.updateOne({ orderNumber: num }, { $set: { orderStatus: 'Delivered', deliveredAt: new Date() } }); assert.equal((await request(app).post('/api/returns').set(A(att.body.token)).send({ orderId: g.body.orderId, reason: 'Changed my mind' })).status, 404, 'and cannot start a return on it');
  assert.equal((await request(app).get(`/api/returns/eligible/${g.body.orderId}`).set(A(att.body.token))).status, 404);
  // the real owner, after verifying that phone by OTP, does see it
  await clearOtpCooldown(); const s = await request(appO).post('/api/customers/otp/send').send({ phone: '9333333333' }); const v = await request(appO).post('/api/customers/otp/verify').send({ termsAccepted: true, phone: '9333333333', code: s.body.devCode }); assert.equal(v.status, 200);
  assert.ok((await request(app).get('/api/customers/me/orders').set(A(v.body.token))).body.some((o) => o.orderNumber === num), 'the verified owner sees their earlier guest order');
});

test('TEAM management: owner-only; add staff, role/disable/reset/unlock; can’t lock yourself out or remove the last owner; disabled people lose access at once', async () => {
  const T = (m, path, b, t) => { let r = request(app)[m]('/api/admin/team' + path).set(A(t || tokens.owner)); return b !== undefined ? r.send(b) : r; };
  assert.equal((await T('get', '', undefined, tokens.staff)).status, 403); assert.equal((await request(app).get('/api/admin/team')).status, 401);
  const list = await T('get', ''); assert.ok(list.body.some((x) => x.email === 'owner@shop.test' && x.role === 'ADMIN')); assert.ok(!JSON.stringify(list.body).includes('passwordHash'));
  for (const bad of [{ name: '', email: 'a@b.co', password: 'Long-enough-pass-1' }, { name: 'X', email: 'nope', password: 'Long-enough-pass-1' }, { name: 'X', email: 'x1@shop.test', password: 'weak' }]) assert.equal((await T('post', '', bad)).status, 400);
  assert.equal((await T('post', '', { name: 'New Staff', email: 'owner@shop.test', password: 'Long-enough-pass-1' })).status, 409);
  const c = await T('post', '', { name: 'Packer Pat', email: 'Packer@Shop.test', role: 'STAFF', password: 'Warehouse-pass-2026' }); assert.equal(c.status, 201); assert.equal(c.body.role, 'STAFF'); assert.equal(c.body.email, 'packer@shop.test');
  const appT = require('../src/app').createApp(); const login = (pw) => request(appT).post('/api/auth/login').send({ email: 'packer@shop.test', password: pw });
  const tk = (await login('Warehouse-pass-2026')).body.token; assert.ok(tk); assert.equal((await request(app).get('/api/admin/orders').set(A(tk))).status, 200); assert.equal((await request(app).put('/api/admin/settings').set(A(tk)).send({ codFee: 1 })).status, 403);
  assert.ok((await T('get', '')).body.find((x) => x.email === 'packer@shop.test').lastLoginAt, 'last login is recorded');
  const id = c.body.id;
  assert.equal((await T('put', '/' + id, { active: false })).status, 200); assert.equal((await request(app).get('/api/admin/orders').set(A(tk))).status, 401, 'a disabled person is logged out on their next request'); assert.equal((await login('Warehouse-pass-2026')).status, 401, 'and cannot log in');
  assert.equal((await T('put', '/' + id, { active: true, password: 'weak' })).status, 400); assert.equal((await T('put', '/' + id, { active: true, password: 'Reset-by-owner-77' })).status, 200); assert.equal((await login('Reset-by-owner-77')).status, 200); assert.equal((await login('Warehouse-pass-2026')).status, 401);
  for (let i = 0; i < 5; i++) await login('wrong'); assert.ok((await T('get', '')).body.find((x) => x.id === id).locked); await T('put', '/' + id, { unlock: true }); assert.equal((await login('Reset-by-owner-77')).status, 200);
  assert.equal((await T('put', '/' + id, { role: 'ADMIN' })).body.role, 'ADMIN'); assert.equal((await T('put', '/' + id, { role: 'STAFF' })).body.role, 'STAFF');
  const me = list.body.find((x) => x.email === 'owner@shop.test').id;
  assert.equal((await T('put', '/' + me, { active: false })).status, 400, 'you cannot switch yourself off'); assert.equal((await T('put', '/' + me, { role: 'STAFF' })).status, 400); assert.equal((await T('put', '/' + me, { password: 'Whatever-pass-123' })).status, 400, 'own password is changed in Settings');
  const owners = (await T('get', '')).body.filter((x) => x.role === 'ADMIN' && x.active); const other = owners.find((x) => x.id !== me);
  if (!other) { const o2 = (await T('post', '', { name: 'Second Owner', email: 'owner2@shop.test', role: 'ADMIN', password: 'Second-owner-2026' })).body; const t2 = (await request(appT).post('/api/auth/login').send({ email: 'owner2@shop.test', password: 'Second-owner-2026' })).body.token; assert.equal((await T('put', '/' + me, { active: false }, t2)).status, 200); assert.equal((await T('put', '/' + o2.id, { active: false }, t2)).status, 400, 'the last active owner can never be disabled'); assert.equal((await T('put', '/' + me, { active: true }, t2)).status, 200); }
  assert.ok(await M.AuditLog.findOne({ action: 'team.created' })); assert.ok(await M.AuditLog.findOne({ action: 'team.updated', summary: /disabled/ }));
});

/* ================= v5: PIN serviceability, stock holds, support, search, carousels, wishlist, consent ================= */
M.SupportTicket = require('../src/models/SupportTicket'); M.Pincode = require('../src/models/Pincode'); M.StockReservation = require('../src/models/StockReservation');
const reset5 = () => request(app).put('/api/admin/settings').set(A(tokens.owner)).send({ requireMobileVerification: false, guestCheckoutEnabled: true, codEnabled: true, otpProvider: 'dev', otpChannel: 'sms', pincodeCheckMode: 'off', stockHoldMinutes: 10, customerLoginEnabled: true, customerSignupEnabled: true, otpEnabled: true, autoCreateAccounts: true });
const reserve = (cartId) => request(app).post('/api/checkout/reserve').send({ cartId });
const heldRows = (product) => M.Product.findById(product.id).then((p) => ({ stock: p.stock, reserved: p.reserved }));
const ageRes = (cartId, minutes) => require('../src/models/StockReservation').collection.updateMany({ cartId, status: 'active' }, { $set: { expiresAt: new Date(Date.now() - minutes * 60e3) } });

test('PIN codes: check API + delivery date; admin import; registry mode blocks checkout; COD per PIN', async () => {
  await reset5();
  const ok = await request(app).get('/api/pincode/600001'); assert.equal(ok.body.serviceable, true); assert.match(ok.body.expected.text, /^Delivery (by|between)/); assert.ok(ok.body.methods.length >= 1); assert.equal(ok.body.registryMode, false);
  assert.equal((await request(app).get('/api/pincode/123')).body.valid, false); assert.equal((await request(app).get('/api/pincode/012345')).body.valid, false);
  const csv = 'pincode,city,state,serviceable,cod,eta\n600001,Chennai,Tamil Nadu,yes,yes,2\n560001,Bengaluru,Karnataka,no,no,\n110001,New Delhi,Delhi,yes,no,4\n12345,bad,row,yes,yes,1\n';
  const imp = (b, t) => request(app).post('/api/admin/pincodes/import').set(A(t || tokens.owner)).send(b);
  assert.equal((await imp({ csv }, tokens.staff)).status, 403, 'only the owner imports'); const r = await imp({ csv }); assert.equal(r.status, 200); assert.equal(r.body.imported, 3); assert.equal(r.body.skipped, 1); assert.match(r.body.errors[0], /12345/);
  assert.equal((await imp({ csv: 'nothing valid' })).status, 400);
  const list = await adm('get', '/pincodes?status=blocked'); assert.equal(list.body.stats.serviceable, 2); assert.equal(list.body.stats.blocked, 1); assert.equal(list.body.pincodes[0].pincode, '560001');
  assert.equal((await adm('put', '/pincodes/600002', { etaDays: 99 })).status, 400); assert.equal((await adm('put', '/pincodes/60000', { city: 'x' })).status, 400); assert.equal((await adm('put', '/pincodes/600002', { city: 'Chennai', state: 'Tamil Nadu', etaDays: 1 })).status, 200);
  // mode OFF: the list is ignored — everything still delivers
  assert.equal((await request(app).get('/api/pincode/560001')).body.serviceable, true);
  assert.equal((await adm('put', '/settings', { pincodeCheckMode: 'registry' })).status, 200);
  const chennai = (await request(app).get('/api/pincode/600001')).body; assert.equal(chennai.serviceable, true); assert.equal(chennai.city, 'Chennai'); assert.match(chennai.expected.text, /^Delivery by/, 'the PIN’s own 2-day ETA overrides the method’s 5–7 days');
  const blocked = (await request(app).get('/api/pincode/560001')).body; assert.equal(blocked.serviceable, false); assert.match(blocked.reason, /right now/); assert.equal((await request(app).get('/api/pincode/999999')).body.reason, 'We don’t deliver to this PIN code yet');
  assert.equal((await request(app).get('/api/pincode/110001')).body.codAvailable, false);
  const stock = await stockOf(S.p1), held0 = (await heldRows(S.p1)).reserved;
  const go = async (pin, body) => place(await cartWith([[S.p1, 1]]), { body: { address: { ...addr, pincode: pin }, ...body } });
  let r1 = await go('560001'); assert.equal(r1.status, 400); assert.equal(r1.body.code, 'NOT_SERVICEABLE'); assert.match(r1.body.error, /PIN 560001/); assert.equal(await stockOf(S.p1), stock); assert.equal((await heldRows(S.p1)).reserved, held0, 'a refused checkout holds nothing');
  assert.equal((await go('999999')).body.code, 'NOT_SERVICEABLE', 'a PIN that is not in the list is refused in registry mode');
  r1 = await go('110001'); assert.equal(r1.status, 400); assert.equal(r1.body.code, 'COD_UNAVAILABLE'); const online = await go('110001', { paymentMethod: 'online' }); assert.equal(online.status, 201, 'the same PIN accepts online payment: ' + JSON.stringify(online.body));
  { const ok600 = await go('600001'); assert.equal(ok600.status, 201, 'a serviceable PIN with COD works: ' + JSON.stringify(ok600.body)); }
  assert.equal((await adm('delete', '/pincodes/110001', undefined, tokens.staff)).status, 403); assert.equal((await adm('delete', '/pincodes/110001')).status, 200); assert.equal((await adm('delete', '/pincodes/110001')).status, 404);
  await adm('put', '/settings', { pincodeCheckMode: 'off' }); assert.equal((await go('560001')).status, 201, 'switching the list off restores delivery everywhere');
});

test('STOCK HOLDS: entering checkout reserves stock (atomic, idempotent), refresh keeps one hold, last unit goes to ONE customer', async () => {
  await reset5(); const P5 = await M.Product.create({ name: 'Hold Test Shelf', slug: 'hold-test-shelf', sku: 'HOLD-1', price: 1000, mrp: 1000, stock: 5 });
  const [c1, c2, c3] = await Promise.all([cartWith([[P5, 3]]), cartWith([[P5, 3]]), cartWith([[P5, 1]])]);
  const a = await reserve(c1); assert.equal(a.status, 200); assert.equal(a.body.reserved, true); assert.ok(a.body.secondsLeft > 590 && a.body.secondsLeft <= 600, 'default hold is 10 minutes'); assert.deepEqual(await heldRows(P5), { stock: 5, reserved: 3 });
  assert.equal((await M.Product.findById(P5.id)).toJSON().available, 2, 'customers now see 5 − 3 = 2 available');
  const again = await Promise.all([1, 2, 3, 4, 5].map(() => reserve(c1))); assert.ok(again.every((x) => x.status === 200)); assert.equal(new Set(again.map((x) => x.body.expiresAt)).size, 1, 'refreshing checkout repeatedly returns the SAME hold and deadline'); assert.equal((await heldRows(P5)).reserved, 3, 'and never reserves twice');
  assert.equal(await require('../src/models/StockReservation').countDocuments({ cartId: c1, status: 'active' }), 1);
  const b = await reserve(c2); assert.equal(b.status, 409); assert.equal(b.body.code, 'OUT_OF_STOCK'); assert.equal(b.body.available, 2); assert.match(b.body.error, /Only 2/);
  const c2b = await cartWith([[P5, 2]]); assert.equal((await reserve(c2b)).status, 200); assert.equal((await heldRows(P5)).reserved, 5); assert.equal((await reserve(c3)).status, 409, 'nothing left');
  assert.equal((await request(app).post('/api/checkout/reserve/release').send({ cartId: c1 })).body.released, 1); assert.equal((await heldRows(P5)).reserved, 2, 'leaving checkout gives the stock back at once'); assert.equal((await reserve(c3)).status, 200); assert.equal((await heldRows(P5)).reserved, 3);
  await request(app).post(`/api/cart/${c3}/items`).send({ productId: P5.id, qty: 2 }); assert.equal((await reserve(c3)).status, 200); assert.deepEqual(await heldRows(P5), { stock: 5, reserved: 4 }, 'changing the basket replaces the hold (1 → 2), not adds to it');
  assert.equal((await request(app).post('/api/checkout/reserve').send({ cartId: 'nope' })).status, 400);
  S.P5 = P5; S.c2b = c2b; S.c3 = c3;
});
test('STOCK HOLDS: paying converts the hold (no double reservation); expiry returns stock; admin can’t take held units; hold time is configurable', async () => {
  const P5 = S.P5; const StockReservation = require('../src/models/StockReservation');
  const r = await place(S.c2b); assert.equal(r.status, 201, JSON.stringify(r.body)); assert.deepEqual(await heldRows(P5), { stock: 3, reserved: 2 }, 'COD order: stock −2 permanently; the hold became the order’s (reserved −2, c3 still holds 2)'); assert.equal((await StockReservation.findOne({ cartId: S.c2b })).status, 'converted');
  await ageRes(S.c3, 1); const notifBefore = await M.Notification.countDocuments({ type: 'reservation_expired' });
  assert.equal(await require('../src/services/reservations').expireReservations(), 1); assert.deepEqual(await heldRows(P5), { stock: 3, reserved: 0 }, 'expired hold → stock back on sale'); assert.equal((await StockReservation.findOne({ cartId: S.c3 }).sort({ createdAt: -1 })).status, 'expired'); assert.equal(await M.Notification.countDocuments({ type: 'reservation_expired' }), notifBefore + 1, 'admin is told');
  assert.equal(await require('../src/services/reservations').expireReservations(), 0, 'running the job again changes nothing');
  const late = await place(S.c3); assert.equal(late.status, 201, 'a customer whose hold expired can still buy if stock remains (it re-reserves)'); assert.deepEqual(await heldRows(P5), { stock: 1, reserved: 0 });
  // admin editing stock while customers are checking out
  const cc = await cartWith([[P5, 1]]); assert.equal((await reserve(cc)).status, 200);
  const adj = (delta) => adm('post', '/inventory/adjust', { productId: P5.id, delta, reason: 'Stock counted' }); const bad = await adj(-1); assert.equal(bad.status, 409); assert.match(bad.body.error, /1 unit is currently held for customers in checkout — you can remove at most 0/);
  assert.equal((await adj(5)).status, 200); assert.equal((await adj(-5)).status, 200, 'what is not held can be removed'); assert.equal((await adm('put', '/products/' + P5.id, { stock: 0 })).status, 409, 'product edits are protected the same way');
  // configurable hold time
  assert.equal((await adm('put', '/settings', { stockHoldMinutes: 2 })).status, 400); assert.equal((await adm('put', '/settings', { stockHoldMinutes: 61 })).status, 400); assert.equal((await adm('put', '/settings', { stockHoldMinutes: 3 })).status, 200);
  await request(app).post('/api/checkout/reserve/release').send({ cartId: cc }); const cd = await cartWith([[P5, 1]]); const short = await reserve(cd); assert.ok(short.body.secondsLeft > 170 && short.body.secondsLeft <= 180, `3-minute hold, got ${short.body.secondsLeft}s`);
  await reset5();
});
test('STOCK HOLDS: five customers race for 3 units (reserve → pay) — exactly 3 succeed, nothing oversold, nothing left held', async () => {
  const P6 = await M.Product.create({ name: 'Race Shelf', slug: 'race-shelf', sku: 'RACE-1', price: 500, mrp: 500, stock: 3 }); const carts = await Promise.all([1, 2, 3, 4, 5].map(() => cartWith([[P6, 1]])));
  const reserved = await Promise.all(carts.map((c) => reserve(c))); assert.equal(reserved.filter((x) => x.status === 200).length, 3); assert.equal(reserved.filter((x) => x.status === 409).length, 2);
  const paid = await Promise.all(carts.map((c) => place(c))); assert.equal(paid.filter((x) => x.status === 201).length, 3, 'the three holders can pay; the two without a hold are told no'); assert.deepEqual(await heldRows(P6), { stock: 0, reserved: 0 });
});
test('STOCK HOLDS: unpaid online orders get a payment grace period; Razorpay is asked before anything is cancelled', async () => {
  await reset5(); const { releaseStaleHolds } = require('../src/services/maintenance'); await releaseStaleHolds(); // flush leftovers from earlier tests
  const o = await onlineOrder();
  await ageOrder(o.orderId, 12); assert.equal(await releaseStaleHolds(), 0, '12 min old with a 10-min hold: still inside the 5-minute payment grace'); assert.equal((await M.Order.findById(o.orderId)).orderStatus, 'Pending');
  await ageOrder(o.orderId, 20); rzPaymentsByOrder[o.razorpayOrderId] = [{ id: 'pay_grace', status: 'captured', amount: o.total * 100, currency: 'INR', method: 'upi' }];
  assert.equal(await releaseStaleHolds(), 0, 'it was actually paid — recovered, not cancelled'); const d = await M.Order.findById(o.orderId); assert.equal(d.paymentStatus, 'Paid'); assert.equal(d.orderStatus, 'Paid');
  const o2 = await onlineOrder(); await ageOrder(o2.orderId, 20); assert.equal(await releaseStaleHolds(), 1, 'genuinely abandoned → released'); assert.equal((await M.Order.findById(o2.orderId)).orderStatus, 'Cancelled');
});

test('SUPPORT tickets: guest and logged-in, validation, account details are authoritative, admin workflow, internal notes stay internal', async () => {
  await reset5(); const send = (b, t) => request(app).post('/api/support').set(t ? A(t) : {}).send(b);
  for (const bad of [{ name: '', email: 'a@b.co', subject: 'Hello', message: 'Need help please' }, { name: 'A', subject: 'Hello', message: 'Need help please' }, { name: 'A', email: 'nope', subject: 'Hello', message: 'Need help please' }, { name: 'A', email: 'a@b.co', subject: 'Hi', message: 'Need help please' }, { name: 'A', email: 'a@b.co', subject: 'Hello', message: 'no' }, { name: 'A', phone: '123', subject: 'Hello', message: 'Need help please' }]) assert.equal((await send(bad)).status, 400, JSON.stringify(bad));
  const bell = await M.Notification.countDocuments({ type: 'support_request' }); sentEmails.length = 0;
  const g = await send({ name: 'Guest Gita', email: 'Gita@Example.com', phone: '+91 98765 11111', orderNumber: '#cl-1001', subject: 'Where is my parcel?', message: 'It has been 9 days.' }); assert.equal(g.status, 201); assert.match(g.body.ticketNumber, /^TKT-\d+$/);
  await wait(300); assert.equal(await M.Notification.countDocuments({ type: 'support_request' }), bell + 1, 'admin bell'); assert.ok(sentEmails.find((e) => e.to === 'owner@shop.test' && /New support request TKT-/.test(e.subject)), 'owner emailed'); assert.ok(sentEmails.find((e) => e.to === 'gita@example.com' && e.html.includes(g.body.ticketNumber)), 'customer gets a reference by email');
  const t0 = await M.SupportTicket.findById(g.body.id); assert.equal(t0.email, 'gita@example.com'); assert.equal(t0.orderNumber, 'CL-1001'); assert.equal(t0.status, 'New'); assert.equal(t0.customerId, null);
  await request(app).put('/api/customers/me').set(A(tokens.asha)).send({ email: 'asha@example.com' });
  const li = await send({ name: 'Fake Name', email: 'fake@evil.com', phone: '1111111111', subject: 'Return help', message: 'Please advise on a return.', orderNumber: S.cod.orderNumber }, tokens.asha); assert.equal(li.status, 201); const t1 = await M.SupportTicket.findById(li.body.id);
  assert.equal(t1.name, 'Asha Kumar', 'a logged-in customer’s name comes from the account, not the form'); assert.equal(t1.phone, '+919876543210'); assert.equal(t1.email, 'asha@example.com'); assert.equal(String(t1.customerId), String((await M.Customer.findOne({ phone: '+919876543210' })).id));
  // admin
  const list = await adm('get', '/support'); assert.ok(list.body.total >= 2); assert.equal(list.body.counts.New >= 2, true); assert.equal((await adm('get', '/support?q=gita')).body.total, 1); assert.equal((await adm('get', '/support?q=CL-1001')).body.total, 1); assert.equal((await adm('get', '/support?status=Resolved')).body.total, 0);
  assert.equal((await adm('get', '/support', undefined, tokens.staff)).status, 200, 'STAFF handle support'); assert.equal((await request(app).get('/api/admin/support')).status, 401);
  assert.equal((await adm('put', `/support/${t1.id}/status`, { status: 'Bogus' })).status, 400); assert.equal((await adm('put', `/support/${t1.id}/status`, { status: 'InProgress' })).body.status, 'InProgress');
  sentEmails.length = 0; const rep = await adm('post', `/support/${t1.id}/reply`, { text: 'Happy to help — your return window is open until Friday.' }); assert.equal(rep.status, 200); assert.equal(rep.body.ticket.status, 'WaitingCustomer'); assert.equal(rep.body.emailed, true); assert.ok(sentEmails.find((e) => e.to === 'asha@example.com' && /Re: Return help \[TKT-/.test(e.subject)));
  assert.equal((await adm('post', `/support/${t1.id}/reply`, { text: 'x' })).status, 400); await adm('post', `/support/${t1.id}/reply`, { text: 'Customer sounded upset — offer a goodwill coupon', internal: true });
  const mine = await request(app).get('/api/support/mine').set(A(tokens.asha)); assert.equal(mine.status, 200); const mt = mine.body.find((x) => x.id === t1.id); assert.deepEqual(mt.messages.map((m) => m.from), ['customer', 'admin'], 'internal notes never reach the customer'); assert.ok(!JSON.stringify(mine.body).includes('goodwill'));
  const re = await request(app).post(`/api/support/mine/${t1.id}/reply`).set(A(tokens.asha)).send({ message: 'Thanks, I will return it.' }); assert.equal(re.status, 200); assert.equal((await M.SupportTicket.findById(t1.id)).status, 'Open', 'a customer reply reopens a waiting ticket');
  assert.equal((await request(app).post(`/api/support/mine/${t1.id}/reply`).set(A(tokens.priya)).send({ message: 'hello?' })).status, 404, 'other customers can’t touch it'); assert.equal((await request(app).get('/api/support/mine')).status, 401);
  await adm('put', `/support/${t1.id}/status`, { status: 'Resolved' }); await request(app).post(`/api/support/mine/${t1.id}/reply`).set(A(tokens.asha)).send({ message: 'One more question' }); assert.equal((await M.SupportTicket.findById(t1.id)).status, 'Open', 'replying to a resolved ticket reopens it');
  assert.ok(await M.AuditLog.findOne({ action: 'support.status_changed' }));
});

test('SEARCH: suggestions, relevance (SKU first), filters, sorting, pagination; drafts hidden; regex-safe', async () => {
  const mk = (o) => M.Product.create({ price: 1000, mrp: 1000, stock: 10, ...o });
  await mk({ name: 'Oak Floating Zorbel', slug: 'oak-floating-zorbel', sku: 'ZORB-OAK', category: 'Zorbels', price: 3200, mrp: 4000, tags: ['storage'] }); await mk({ name: 'Teak Hook Rack', slug: 'teak-hook-rack', sku: 'HOOK-TEAK', category: 'Wall Organizers', price: 1800, mrp: 1800 });
  await mk({ name: 'Draft Zorbel Secret', slug: 'draft-zorbel', sku: 'ZORB-DRAFT', category: 'Zorbels', status: 'draft' }); await mk({ name: 'Sold Out Zorbel', slug: 'sold-out-zorbel', sku: 'ZORB-OUT', category: 'Zorbels', stock: 0, price: 900 });
  const sg = (q) => request(app).get('/api/search/suggest?q=' + encodeURIComponent(q)).then((r) => r.body);
  assert.deepEqual(await sg('s'), { products: [], categories: [] }, 'needs 2+ characters'); const s1 = await sg('zorb'); assert.ok(s1.products.some((p) => p.slug === 'oak-floating-zorbel')); assert.ok(!s1.products.some((p) => p.slug === 'draft-zorbel'), 'drafts never appear'); assert.ok(s1.categories.some((c) => c.name === 'Zorbels')); const p0 = s1.products[0]; assert.ok(p0.name && p0.price && 'mrp' in p0 && Array.isArray(p0.images) && p0.sku, 'image, price, MRP, SKU included');
  assert.equal((await sg('zorb-oak')).products[0].sku, 'ZORB-OAK', 'an exact SKU ranks first'); assert.ok((await sg('HOOK')).products.some((p) => p.slug === 'teak-hook-rack'), 'SKU / case-insensitive'); assert.ok((await sg('storage')).products.some((p) => p.slug === 'oak-floating-zorbel'), 'tags are searched');
  assert.doesNotThrow(async () => sg('.*(')); assert.equal((await request(app).get('/api/search?q=' + encodeURIComponent('(((['))).status, 200); assert.equal((await request(app).get('/api/search?q=' + encodeURIComponent('.*'))).body.total, 0, 'regex characters are literal');
  const q = (qs) => request(app).get('/api/search?' + qs).then((r) => r.body);
  const all = await q('q=zorbel'); assert.deepEqual(all.products.map((p) => p.slug).sort(), ['oak-floating-zorbel', 'sold-out-zorbel']); assert.ok(all.facets.categories.some((c) => c.name === 'Zorbels' && c.count === 2)); assert.equal(all.facets.minPrice, 900); assert.equal(all.facets.maxPrice, 3200);
  assert.equal((await q('q=zorbel&inStock=1')).total, 1); assert.deepEqual((await q('q=zorbel&sort=price-low')).products.map((p) => p.price), [900, 3200]); assert.deepEqual((await q('q=zorbel&sort=price-high')).products.map((p) => p.price), [3200, 900]); assert.equal((await q('q=zorbel&sort=discount')).products[0].slug, 'oak-floating-zorbel');
  assert.equal((await q('q=zorbel&minPrice=1000&maxPrice=5000')).total, 1); assert.equal((await q('q=zorbel&category=Wall%20Organizers')).total, 0); assert.equal((await q('category=Wall%20Organizers')).products[0].slug, 'teak-hook-rack', 'browse without a query');
  const pg = await q('limit=2&page=2'); assert.equal(pg.products.length, 2); assert.ok(pg.pages >= 2); assert.equal((await q('q=zzzzzz')).total, 0);
});

test('CAROUSELS: admin picks products and their order; auto new-arrivals / best-sellers; archived and disabled ones vanish; owner-only', async () => {
  const col = async () => (await request(app).get('/api/collections')).body.collections; const find = (cs, k) => cs.find((c) => c.key === k);
  const prods = await M.Product.find({ status: 'active' }).sort({ createdAt: 1 }); const [a, b, c] = [prods[0], prods[1], prods[2]];
  assert.equal((await adm('put', '/catalog/collections/featured/products', { productIds: [c.id, a.id] }, tokens.staff)).status, 403); assert.equal((await adm('put', '/catalog/collections/nope/products', { productIds: [] })).status, 404);
  assert.equal((await adm('put', '/catalog/collections/featured/products', { productIds: [c.id, a.id, b.id] })).body.count, 3); let f = find(await col(), 'featured'); assert.deepEqual(f.products.map((p) => p.id), [c.id, a.id, b.id], 'shown in the admin’s order'); assert.ok(f.products[0].price && f.products[0].images && 'mrp' in f.products[0] && 'available' in f.products[0] && f.products[0].slug, 'image, name, MRP, price, stock info');
  await adm('put', '/catalog/collections/featured/products', { productIds: [b.id, c.id] }); f = find(await col(), 'featured'); assert.deepEqual(f.products.map((p) => p.id), [b.id, c.id]); assert.ok(!(await M.Product.findById(a.id)).collections.includes('featured'), 'removed products leave the collection');
  await M.Product.updateOne({ _id: b.id }, { $set: { status: 'archived' } }); assert.deepEqual(find(await col(), 'featured').products.map((p) => p.id), [c.id], 'archived products disappear'); await M.Product.updateOne({ _id: b.id }, { $set: { status: 'active' } });
  const nw = find(await col(), 'new-arrivals'); assert.ok(nw.products.length >= 3); const dates = (await M.Product.find({ _id: { $in: nw.products.map((p) => p.id) } })).reduce((m, p) => ((m[p.id] = +new Date(p.createdAt)), m), {}); assert.ok(nw.products.every((p, i, arr) => !i || dates[arr[i - 1].id] >= dates[p.id]), 'newest first');
  const best = find(await col(), 'best-sellers'); assert.ok(best && best.products.length >= 1, 'best sellers come from real sales'); assert.equal(best.products[0].id, S.p1.id, 'the product with the most units sold leads');
  assert.equal(find(await col(), 'recommended'), undefined, 'a collection that is switched off is hidden'); assert.equal((await adm('put', '/catalog/collections', { collections: [{ key: 'recommended', enabled: true, mode: 'manual', title: 'Picked for you', limit: 4 }] }, tokens.staff)).status, 403);
  await adm('put', '/catalog/collections', { collections: [{ key: 'recommended', enabled: true, mode: 'manual', title: 'Picked for you', limit: 4 }, { key: 'featured', enabled: false }] }); await adm('put', '/catalog/collections/recommended/products', { productIds: [a.id] });
  const after = await col(); assert.equal(find(after, 'recommended').title, 'Picked for you'); assert.equal(find(after, 'featured'), undefined); const cfg = (await adm('get', '/catalog/collections')).body; assert.ok(cfg.products.length >= 5); assert.deepEqual(cfg.collections.find((x) => x.key === 'recommended').productIds, [a.id]);
  await adm('put', '/catalog/collections', { collections: [{ key: 'featured', enabled: true }, { key: 'recommended', enabled: false }] });
});

test('LOGIN consent + WISHLIST: Terms must be accepted (checked before the code is used); wishlist follows the account', async () => {
  await reset5(); const appO = require('../src/app').createApp(); const ph = '9777000111';
  const send = async () => (await request(appO).post('/api/customers/otp/send').send({ phone: ph })).body.devCode;
  let code = await send(); const no = await request(appO).post('/api/customers/otp/verify').send({ phone: ph, code }); assert.equal(no.status, 400); assert.equal(no.body.code, 'TERMS_REQUIRED'); assert.equal((await request(appO).post('/api/customers/otp/verify').send({ phone: ph, code, termsAccepted: 'yes' })).status, 400, 'must be literally true');
  const yes = await request(appO).post('/api/customers/otp/verify').send({ phone: ph, code, termsAccepted: true }); assert.equal(yes.status, 200, 'the code was NOT used up by the refused attempts'); assert.ok((await M.Customer.findOne({ phone: '+91' + ph })).termsAcceptedAt, 'consent time recorded');
  assert.equal((await request(appO).post('/api/customers/signup').send({ name: 'No Terms', email: 'nt@example.com', password: 'long-enough-1' })).status, 400);
  const T = yes.body.token, prods = (await M.Product.find({ status: 'active' }).limit(3)).map((p) => p.id);
  const put = (b, t = T) => request(app).put('/api/customers/me/wishlist').set(A(t)).send(b);
  assert.equal((await request(app).get('/api/customers/me/wishlist')).status, 401); assert.deepEqual((await put({ ids: [prods[0], prods[0], 'bogus', '000000000000000000000000'] })).body.ids, [prods[0]], 'duplicates, junk and unknown ids are dropped');
  assert.deepEqual((await put({ ids: [prods[1]], merge: true })).body.ids.sort(), [prods[0], prods[1]].sort(), 'a guest’s local list merges into the account'); const w = (await request(app).get('/api/customers/me/wishlist').set(A(T))).body; assert.equal(w.products.length, 2); assert.ok(w.products[0].price && w.products[0].images);
  assert.deepEqual((await put({ ids: [prods[2]] })).body.ids, [prods[2]], 'without merge it replaces'); await M.Product.updateOne({ _id: prods[2] }, { $set: { status: 'draft' } }); assert.equal((await request(app).get('/api/customers/me/wishlist').set(A(T))).body.products.length, 0, 'products taken off sale vanish from the wishlist'); await M.Product.updateOne({ _id: prods[2] }, { $set: { status: 'active' } });
  assert.deepEqual((await request(app).get('/api/customers/me/wishlist').set(A(tokens.asha))).body.ids, [], 'wishlists are private to the account');
});

/* ================= v6: order IDs, reward points, cashback, gift cards, wallet refunds ================= */
M.GiftCard = require('../src/models/GiftCard'); M.RewardLedger = require('../src/models/RewardLedger');
const reset6 = () => adm('put', '/settings', { requireMobileVerification: false, guestCheckoutEnabled: true, codEnabled: true, codFee: 0, prepaidDiscountPercent: 0, otpProvider: 'dev', otpChannel: 'sms', otpEnabled: true, customerLoginEnabled: true, customerSignupEnabled: true, autoCreateAccounts: true, pincodeCheckMode: 'off', rewardsEnabled: true, giftCardsEnabled: true, rewardEarnPercent: 5, rewardRedeemMaxPercent: 20, rewardRedeemMinPoints: 100, cashbackPercent: 0, cashbackMinOrder: 0, returnWindowDays: 7 });
const loginCustomer = async (phone) => { await require('../src/models/OtpRequest').deleteMany({}); const a = require('../src/app').createApp(); const sd = await request(a).post('/api/customers/otp/send').send({ phone }); const v = await request(a).post('/api/customers/otp/verify').send({ phone, code: sd.body.devCode, name: 'Rewards ' + phone.slice(-4), termsAccepted: true }); assert.equal(v.status, 200, JSON.stringify(v.body)); return { token: v.body.token, id: v.body.customer.id }; };
const cust = (id) => M.Customer.findById(id); const ord = (id) => M.Order.findById(id);
const deliveredAgo = (id, days) => M.Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: { orderStatus: 'Delivered', deliveredAt: new Date(Date.now() - days * 86400e3) } });
const pay6 = async (o) => { const pay = 'pay_w' + Math.random().toString(36).slice(2, 10); const r = await request(app).post('/api/payments/verify').send({ orderId: o.orderId, razorpay_order_id: o.razorpayOrderId, razorpay_payment_id: pay, razorpay_signature: sign(o.razorpayOrderId, pay) }); assert.equal(r.status, 200, JSON.stringify(r.body)); return pay; };
const giveCard = async (amount, extra = {}) => (await adm('post', '/rewards/gift-cards', { amount, ...extra })).body.cards[0];
const walkToRefund = async (retId) => { for (const st of ['APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'INSPECTION', 'REFUND_PENDING']) { const r = await adm('put', `/returns/${retId}/status`, { status: st, ...(st === 'PICKUP_SCHEDULED' ? { pickup: { scheduledAt: '2026-10-08', courier: 'X' } } : {}), ...(st === 'REFUND_PENDING' ? { inspection: { result: 'passed', restock: true } } : {}) }); assert.equal(r.status, 200, st + ' ' + JSON.stringify(r.body)); } };

test('ORDER IDS: FY####CL### — restarts at 001 each financial year, unique under races, tracking works with the new format', async () => {
  await reset6(); const r1 = await place(await cartWith([[S.p1, 1]])), r2 = await place(await cartWith([[S.p1, 1]]));
  const re = /^FY(\d{4})CL(\d{3,})$/; assert.match(r1.body.orderNumber, re); assert.match(r2.body.orderNumber, re); assert.equal(+r2.body.orderNumber.match(re)[2], +r1.body.orderNumber.match(re)[2] + 1, 'consecutive');
  const fy = require('../src/utils/generateOrderNumber').financialYear(new Date()); assert.equal(+r1.body.orderNumber.match(re)[1], fy);
  const gen = require('../src/utils/generateOrderNumber'); const a = await gen(new Date('2027-04-01T00:00:00+05:30')), b = await gen(new Date('2027-04-01T00:00:00+05:30')); assert.deepEqual([a, b], ['FY2027CL001', 'FY2027CL002'], 'a new financial year starts again at 001'); assert.equal(await gen(new Date('2026-04-01T00:00:00+05:30')).then((x) => /^FY2026CL\d{3,}$/.test(x)), true);
  const batch = await Promise.all(Array.from({ length: 8 }, async () => (await place(await cartWith([[S.p1, 1]]))).body.orderNumber)); assert.equal(new Set(batch).size, 8, 'eight simultaneous orders, eight different numbers');
  const t = await request(app).get('/api/track?orderNumber=' + r1.body.orderNumber + '&email=asha@example.com'); assert.equal(t.status, 200); assert.equal(t.body.orderNumber, r1.body.orderNumber); assert.equal((await request(app).get('/api/track?orderNumber=%23' + r1.body.orderNumber.toLowerCase() + '&email=asha@example.com')).status, 200, '“#fy2026cl001” also works');
});

test('POINTS: ₹1000 → 50, ₹500 → 25; pending until the return window after delivery ends; credited exactly once; guests earn nothing', async () => {
  await reset6(); const P = await M.Product.create({ name: 'Reward Shelf', slug: 'reward-shelf', sku: 'RWD-1', price: 1000, mrp: 1000, stock: 500 }), Q = await M.Product.create({ name: 'Reward Hook', slug: 'reward-hook', sku: 'RWD-2', price: 500, mrp: 500, stock: 500 }); S.P = P; S.Q = Q;
  const rita = await loginCustomer('9444400001'); S.rita = rita;
  const a = await place(await cartWith([[P, 1]]), { auth: rita.token }); const b = await place(await cartWith([[Q, 1]]), { auth: rita.token }); assert.equal(a.status, 201); const oa = await ord(a.body.orderId), ob = await ord(b.body.orderId);
  assert.equal(oa.wallet.pointsEarned, 50); assert.equal(ob.wallet.pointsEarned, 25); assert.equal(oa.wallet.earnStatus, 'pending'); let c = await cust(rita.id); assert.deepEqual([c.rewardPoints, c.rewardPending], [0, 75], 'earned points wait; nothing spendable yet');
  const led = await M.RewardLedger.find({ customerId: rita.id, type: 'earn' }); assert.equal(led.length, 2); assert.ok(led.every((l) => l.affects === 'pending'));
  const guest = await place(await cartWith([[P, 1]])); assert.equal((await ord(guest.body.orderId)).wallet.pointsEarned, 0, 'guests have no account to earn into');
  const rw = require('../src/services/rewards'); await deliveredAgo(a.body.orderId, 3); await deliveredAgo(b.body.orderId, 3); assert.equal(await rw.creditPending(), 0, 'delivered 3 days ago, window is 7');
  const openRet = await request(app).post('/api/returns').set(A(rita.token)).send({ orderId: b.body.orderId, items: [{ index: 0, qty: 1 }], reason: 'Changed my mind' }); assert.equal(openRet.status, 201, JSON.stringify(openRet.body));
  await deliveredAgo(a.body.orderId, 8); await deliveredAgo(b.body.orderId, 8);
  assert.equal(await rw.creditPending(), 1, 'the order with an open return waits; the other is credited'); c = await cust(rita.id); assert.deepEqual([c.rewardPoints, c.rewardPending], [50, 25]);
  assert.equal(await rw.creditPending(), 0, 'running the job again credits nothing twice'); assert.equal((await ord(a.body.orderId)).wallet.earnStatus, 'credited');
  const me = await request(app).get('/api/rewards/me').set(A(rita.token)); assert.equal(me.body.points, 50); assert.equal(me.body.pending, 25); assert.equal(me.body.rules.earnPercent, 5); assert.ok(me.body.history.some((h) => h.type === 'credit' && h.points === 50)); assert.equal((await request(app).get('/api/rewards/me')).status, 401);
  await M.Return.updateOne({ _id: openRet.body.id }, { $set: { status: 'CLOSED' } }); assert.equal(await rw.creditPending(), 1, 'once the return is closed the points are credited'); assert.equal((await cust(rita.id)).rewardPoints, 75);
});

test('REDEEM: capped at 20% of goods and the balance, 100-point minimum, logged-in only; earns on what was paid in cash; double-spend is impossible', async () => {
  await reset6(); const { P } = S; const kim = await loginCustomer('9444400002'); const give = (n) => adm('post', `/rewards/customers/${kim.id}/adjust`, { points: n, note: 'test' });
  assert.equal((await adm('post', `/rewards/customers/${kim.id}/adjust`, { points: 300 }, tokens.staff)).status, 403, 'owner only'); assert.equal((await give(300)).status, 200); assert.equal((await give(-1000)).status, 400, 'cannot go below zero'); assert.equal((await give(0)).status, 400);
  const r = await place(await cartWith([[P, 1]]), { auth: kim.token, body: { usePoints: true } }); assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.total, 800, '20% of ₹1000 = ₹200 off'); const o = await ord(r.body.orderId);
  assert.deepEqual([o.wallet.pointsUsed, o.wallet.pointsValue, o.wallet.pointsEarned, o.total, o.wallet.taken], [200, 200, 40, 800, true], 'earns 5% of the ₹800 paid in cash'); assert.equal((await cust(kim.id)).rewardPoints, 100);
  assert.equal((await place(await cartWith([[P, 1]]), { auth: kim.token, body: { usePoints: 50 } })).body.total, 1000, 'below the 100-point minimum nothing is applied');
  const g = await place(await cartWith([[P, 1]]), { body: { usePoints: 200 } }); assert.equal(g.status, 400); assert.match(g.body.error, /Log in/);
  await give(200); assert.equal((await cust(kim.id)).rewardPoints, 300);
  const both = await Promise.all([1, 2].map(async () => place(await cartWith([[P, 1]]), { auth: kim.token, body: { usePoints: true } }))); assert.deepEqual(both.map((x) => x.status).sort(), [201, 400], 'two phones, one balance: exactly one order gets the points');
  assert.equal((await cust(kim.id)).rewardPoints, 100, 'never spent twice, never negative'); assert.match(both.find((x) => x.status === 400).body.error, /balance changed/); assert.equal(await M.Order.countDocuments({ 'customer.phone': '+919876543210', orderStatus: 'Cancelled', 'wallet.pointsUsed': 0 }) >= 0, true);
  const pv = await request(app).post('/api/rewards/preview').set(A(kim.token)).send({ goodsPayable: 1000, shipping: 0, codFee: 0, paymentMethod: 'cod', usePoints: true }); assert.deepEqual([pv.body.balance, pv.body.maxPoints, pv.body.pointsUsed, pv.body.cashTotal, pv.body.earn.points], [100, 100, 100, 900, 45], 'preview matches what checkout will do'); assert.equal((await adm('put', '/settings', { rewardEarnPercent: 80 })).status, 400);
  S.kim = kim;
});

test('CASHBACK: extra points on PREPAID orders only, also pending until the window ends', async () => {
  await reset6(); await adm('put', '/settings', { cashbackPercent: 2, cashbackMinOrder: 500 }); const { P, Q } = S; const lee = await loginCustomer('9444400003');
  const on = async (prod, method, extra = {}) => { const c = await cartWith([[prod, 1]]); if (method === 'cod') return place(c, { auth: lee.token }); const rr = await request(app).post('/api/checkout').set(A(lee.token)).send({ cartId: c, paymentMethod: 'online', customer: { name: 'Lee', phone: '9444400003', email: 'lee@example.com' }, address: addr, ...extra }); return rr; };
  const prepaid = await on(P, 'online'); assert.equal(prepaid.status, 201); const op = await ord(prepaid.body.orderId); assert.deepEqual([op.wallet.pointsEarned, op.wallet.cashbackEarned], [50, 20]); const cod = await on(P, 'cod'); assert.equal((await ord(cod.body.orderId)).wallet.cashbackEarned, 0);
  assert.equal((await ord((await on(Q, 'online', {})).body.orderId)).wallet.cashbackEarned, 10, '2% of ₹500, minimum order met');
  await pay6(prepaid.body); const c = await cust(lee.id); assert.equal(c.rewardPending, 70 + 50, 'prepaid ₹1000: 50 + 20; COD ₹1000: 50 — the unpaid ₹500 order is not counted yet'); assert.ok(await M.RewardLedger.findOne({ customerId: lee.id, source: 'cashback', affects: 'pending' }));
  await adm('put', '/settings', { cashbackPercent: 0, cashbackMinOrder: 0 });
});

test('GIFT CARDS: owner-issued, case/space-insensitive, partial use keeps the balance, fully-covered orders are paid at once, codes never leak', async () => {
  await reset6(); const { P } = S; assert.equal((await adm('post', '/rewards/gift-cards', { amount: 500 }, tokens.staff)).status, 403); for (const bad of [0, -5, 1.5, 200000, 'x']) assert.equal((await adm('post', '/rewards/gift-cards', { amount: bad })).status, 400, String(bad));
  const issued = await adm('post', '/rewards/gift-cards', { amount: 500, expiryMonths: 6, note: 'Diwali' }); assert.equal(issued.status, 201); const card = issued.body.cards[0]; assert.match(card.code, /^GC-[A-HJKMNPQRT-Y346789]{4}-[A-HJKMNPQRT-Y346789]{4}-[A-HJKMNPQRT-Y346789]{4}$/); assert.ok(new Date(card.expiresAt) > new Date());
  assert.equal((await adm('post', '/rewards/gift-cards', { amount: 100, count: 3 })).body.cards.length, 3); assert.equal(new Set((await adm('get', '/rewards/gift-cards')).body.cards.map((c) => c.code)).size, (await M.GiftCard.countDocuments()), 'all codes unique');
  const chk = await request(app).post('/api/rewards/gift-card/check').send({ code: card.code.toLowerCase() }); assert.equal(chk.body.balance, 500); const miss = await request(app).post('/api/rewards/gift-card/check').send({ code: 'GC-AAAA-AAAA-AAAA' }); assert.equal(miss.status, 404);
  const typed = card.code.toLowerCase().replace(/-/g, ' - ');
  const part = await place(await cartWith([[P, 1]]), { body: { giftCardCodes: [typed] } }); assert.equal(part.status, 201, JSON.stringify(part.body)); assert.equal(part.body.total, 500, 'a ₹500 card pays half of a ₹1000 order'); assert.equal((await M.GiftCard.findById(card.id)).balance, 0);
  assert.equal((await place(await cartWith([[P, 1]]), { body: { giftCardCodes: [card.code] } })).status, 400, 'a spent card is refused');
  const big = await giveCard(3000); const full = await place(await cartWith([[P, 1]]), { body: { giftCardCodes: [big.code] } }); assert.equal(full.status, 201, JSON.stringify(full.body)); assert.equal(full.body.paid, true); const fo = await ord(full.body.orderId);
  assert.deepEqual([fo.total, fo.paymentStatus, fo.orderStatus, fo.payment.method, fo.wallet.giftTotal], [0, 'Paid', 'Paid', 'wallet', 1000], 'covered by the card: paid immediately'); assert.ok(fo.invoiceNumber); assert.equal((await M.GiftCard.findById(big.id)).balance, 2000, 'the unused balance stays on the card');
  const tj = await request(app).get('/api/track?orderNumber=' + fo.orderNumber + '&email=asha@example.com'); assert.ok(!JSON.stringify(tj.body).includes(big.code), 'the code is never in tracking'); assert.ok(!JSON.stringify((await adm('get', '/orders/' + fo.id)).body).includes(big.code), 'nor in the admin order view'); assert.match(JSON.stringify((await adm('get', '/orders/' + fo.id)).body), /GC-••••-••••-/, 'shown masked'); assert.equal(tj.body.wallet.giftTotal, 1000, 'tracking shows how much the gift card paid');
  const exp = await giveCard(500); await M.GiftCard.updateOne({ _id: exp.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } }); assert.equal((await place(await cartWith([[P, 1]]), { body: { giftCardCodes: [exp.code] } })).status, 400, 'expired');
  const dis = await giveCard(500); assert.equal((await adm('put', '/rewards/gift-cards/' + dis.id, { status: 'disabled' })).body.status, 'disabled'); assert.equal((await place(await cartWith([[P, 1]]), { body: { giftCardCodes: [dis.code] } })).status, 400, 'disabled'); assert.equal((await adm('put', '/rewards/gift-cards/' + dis.id, { status: 'disabled' }, tokens.staff)).status, 403);
  const race = await giveCard(1000); const rs = await Promise.all([1, 2].map(async () => place(await cartWith([[P, 1]]), { body: { giftCardCodes: [race.code] } }))); assert.deepEqual(rs.map((x) => x.status).sort(), [201, 400], 'one card, two simultaneous orders: it can only be spent once'); assert.equal((await M.GiftCard.findById(race.id)).balance, 0);
  await adm('put', '/settings', { giftCardsEnabled: false }); const off = await giveCard(500); const o2 = await place(await cartWith([[P, 1]]), { body: { giftCardCodes: [off.code] } }); assert.equal(o2.status, 400); assert.match(o2.body.error, /not being accepted/); assert.equal((await request(app).post('/api/rewards/gift-card/check').send({ code: off.code })).status, 404); await adm('put', '/settings', { giftCardsEnabled: true });
  const ad = await adm('put', '/rewards/gift-cards/' + off.id, { adjust: -600 }); assert.equal(ad.status, 400); assert.equal((await adm('put', '/rewards/gift-cards/' + off.id, { adjust: 100 })).body.balance, 600);
  const sum = (await adm('get', '/rewards/summary')).body; assert.ok(sum.giftCardLiability >= 2600 && sum.giftCardsActive >= 3, JSON.stringify(sum));
  S.bigCard = big;
});

test('CANCELLATION and abandoned checkouts give points and gift-card money back and withdraw the earned points', async () => {
  await reset6(); const { P } = S; const amy = await loginCustomer('9444400004'); await adm('post', `/rewards/customers/${amy.id}/adjust`, { points: 300, note: 'seed' }); const card = await giveCard(300);
  const r = await place(await cartWith([[P, 1]]), { auth: amy.token, body: { usePoints: true, giftCardCodes: [card.code] } }); assert.equal(r.status, 201); const o = await ord(r.body.orderId);
  assert.deepEqual([o.wallet.pointsUsed, o.wallet.giftTotal, o.total, o.wallet.pointsEarned], [200, 300, 500, 25]); let c = await cust(amy.id); assert.deepEqual([c.rewardPoints, c.rewardPending, (await M.GiftCard.findById(card.id)).balance], [100, 25, 0]);
  const cancel = await adm('put', `/orders/${r.body.orderId}/status`, { orderStatus: 'Cancelled', note: 'test' }); assert.equal(cancel.status, 200);
  c = await cust(amy.id); assert.deepEqual([c.rewardPoints, c.rewardPending, (await M.GiftCard.findById(card.id)).balance], [300, 0, 300], 'points and card money restored; pending points withdrawn'); assert.equal((await ord(r.body.orderId)).wallet.earnStatus, 'void');
  assert.equal(await require('../src/services/rewards').restoreWallet(await ord(r.body.orderId), 999), 0, 'restoring again gives nothing more');
  const on = await request(app).post('/api/checkout').set(A(amy.token)).send({ cartId: await cartWith([[P, 1]]), paymentMethod: 'online', usePoints: true, customer: { name: 'Amy', phone: '9444400004', email: 'amy@example.com' }, address: addr }); assert.equal(on.status, 201); assert.equal((await cust(amy.id)).rewardPoints, 100, 'points are held while the payment is pending');
  await ageOrder(on.body.orderId, 40); assert.equal(await require('../src/services/maintenance').releaseStaleHolds(), 1); c = await cust(amy.id); assert.deepEqual([c.rewardPoints, c.rewardPending], [300, 0], 'an abandoned checkout returns the points');
  assert.equal((await ord(on.body.orderId)).orderStatus, 'Cancelled');
});

test('RETURNS: the cash part goes back to the original payment, the wallet part back to the wallet, earned points are clawed back proportionally', async () => {
  await reset6(); const { P } = S; const zoe = await loginCustomer('9444400005'); await adm('post', `/rewards/customers/${zoe.id}/adjust`, { points: 300, note: 'seed' });
  const o = await request(app).post('/api/checkout').set(A(zoe.token)).send({ cartId: await cartWith([[P, 2]]), paymentMethod: 'online', usePoints: true, customer: { name: 'Zoe', phone: '9444400005', email: 'zoe@example.com' }, address: addr }); assert.equal(o.status, 201, JSON.stringify(o.body)); const ordr = await ord(o.body.orderId);
  assert.deepEqual([ordr.subtotal, ordr.wallet.pointsUsed, ordr.total, ordr.wallet.pointsEarned], [2000, 300, 1700, 85], '₹2000: 300 points (cap 400, balance 300), ₹1700 online, earns 5% of ₹1700'); assert.equal(rzOrders[o.body.razorpayOrderId].amount, 170000, 'Razorpay is only asked for the cash part');
  const pay = await pay6(o.body); await deliveredAgo(o.body.orderId, 1); let z = await cust(zoe.id); assert.deepEqual([z.rewardPoints, z.rewardPending], [0, 85]);
  const rr = await request(app).post('/api/returns').set(A(zoe.token)).send({ orderId: o.body.orderId, items: [{ index: 0, qty: 1 }], reason: 'Changed my mind' }); assert.equal(rr.status, 201, JSON.stringify(rr.body)); assert.equal(rr.body.amount, 1000, 'the full value of one unit is refundable'); await walkToRefund(rr.body.id);
  const before = rzRefunds.length; const rf = await adm('post', `/returns/${rr.body.id}/refund`, {}); assert.equal(rf.status, 200, JSON.stringify(rf.body)); assert.equal(rzRefunds.length, before + 1); assert.equal(rzRefunds[before].amount, 85000, '₹850 (half of the ₹1700 cash) goes back through Razorpay'); assert.equal(rzRefunds[before].payment_id, pay);
  z = await cust(zoe.id); assert.equal(z.rewardPoints, 150, 'half of the 300 points used come back'); assert.equal(z.rewardPending, 85 - 43, 'half of the earned points (43) are withdrawn'); const od = await ord(o.body.orderId); assert.deepEqual([od.refundedAmount, od.wallet.restored, od.paymentStatus], [850, 150, 'Paid']); const rd = await M.Return.findById(rr.body.id); assert.equal(rd.walletRefund, 150);
  const rr2 = await request(app).post('/api/returns').set(A(zoe.token)).send({ orderId: o.body.orderId, items: [{ index: 0, qty: 1 }], reason: 'Changed my mind' }); assert.equal(rr2.status, 201, JSON.stringify(rr2.body)); assert.equal(rr2.body.amount, 1000); await walkToRefund(rr2.body.id); assert.equal((await adm('post', `/returns/${rr2.body.id}/refund`, {})).status, 200);
  z = await cust(zoe.id); od2 = await ord(o.body.orderId); assert.deepEqual([z.rewardPoints, z.rewardPending, od2.refundedAmount, od2.wallet.restored, od2.paymentStatus], [300, 0, 1700, 300, 'Refunded'], 'everything back: all 300 points, all cash, no earned points left'); assert.equal((await adm('post', `/returns/${rr2.body.id}/refund`, {})).status, 409);
});
let od2;
test('RETURNS on a fully gift-card-paid order: refunded to the gift card — no Razorpay involved', async () => {
  await reset6(); const { P } = S; const card = await giveCard(1500); const amy = await loginCustomer('9444400006');
  const r = await place(await cartWith([[P, 1]]), { auth: amy.token, body: { giftCardCodes: [card.code] } }); assert.equal(r.body.paid, true); assert.equal((await M.GiftCard.findById(card.id)).balance, 500); await deliveredAgo(r.body.orderId, 1);
  const rr = await request(app).post('/api/returns').set(A(amy.token)).send({ orderId: r.body.orderId, items: [{ index: 0, qty: 1 }], reason: 'Changed my mind' }); assert.equal(rr.status, 201, JSON.stringify(rr.body)); assert.equal(rr.body.amount, 1000); await walkToRefund(rr.body.id);
  const before = rzRefunds.length; const rf = await adm('post', `/returns/${rr.body.id}/refund`, {}); assert.equal(rf.status, 200, JSON.stringify(rf.body)); assert.equal(rzRefunds.length, before, 'no payment-gateway refund — there was no card/UPI payment'); assert.equal(rf.body.refund.method, 'wallet'); assert.equal(rf.body.return.status, 'REFUNDED');
  assert.equal((await M.GiftCard.findById(card.id)).balance, 1500, 'the gift card has its ₹1000 back'); assert.equal((await ord(r.body.orderId)).paymentStatus, 'Refunded');
});
test('REWARDS admin: summary, customer lookup with history, adjustments are audited', async () => {
  const s = (await adm('get', '/rewards/summary')).body; assert.ok(s.pointsOutstanding > 0 && s.pointHolders >= 1); assert.deepEqual((await adm('get', '/rewards/customers?q=ab')).body, [], 'needs 3+ characters'); const f = (await adm('get', '/rewards/customers?q=Rewards')).body; assert.ok(f.length >= 1 && 'points' in f[0]);
  const d = (await adm('get', '/rewards/customers/' + f[0].id)).body; assert.ok(Array.isArray(d.ledger)); assert.ok(await M.AuditLog.findOne({ action: 'rewards.adjusted' })); assert.ok(await M.AuditLog.findOne({ action: 'giftcard.issued' })); assert.equal((await request(app).get('/api/admin/rewards/summary')).status, 401);
});

test('TEARDOWN', async () => { await db.stop(); courierServer.close(); setTimeout(() => process.exit(0), 200).unref(); });
