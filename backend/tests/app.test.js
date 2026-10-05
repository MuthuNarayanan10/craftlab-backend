// Integration tests against the REAL Express app (all routers, middleware and models) — no database needed:
// these exercise everything that happens BEFORE a query runs: security headers, CORS, auth boundaries, limits, signatures.
process.env.JWT_SECRET = 'test-secret-'.repeat(4); process.env.NODE_ENV = 'test';
const mongoose = require('mongoose'); mongoose.set('bufferCommands', false);
const test = require('node:test'); const assert = require('node:assert/strict');
const request = require('supertest'); const jwt = require('jsonwebtoken'); const crypto = require('crypto');
const { createApp } = require('../src/app');
const { razorpayProvider } = require('../src/utils/paymentProvider');
const { setPaymentProvider } = require('../src/utils/paymentProvider');

const app = createApp();
const adminToken = (extra = {}) => jwt.sign({ sub: '64b000000000000000000001', type: 'admin', ...extra }, process.env.JWT_SECRET);
const customerToken = () => jwt.sign({ sub: '64b000000000000000000002', type: 'customer' }, process.env.JWT_SECRET);

test('health reports the database state honestly (503 when it is down)', async () => {
  const r = await request(app).get('/api/health'); assert.equal(r.status, 503); assert.equal(r.body.status, 'degraded'); assert.equal(r.body.database, 'disconnected');
});
test('security headers, request id, no x-powered-by', async () => {
  const r = await request(app).get('/api/health');
  assert.ok(r.headers['x-request-id']); assert.equal(r.headers['x-powered-by'], undefined);
  assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.match(r.headers['strict-transport-security'] || '', /max-age/); assert.ok(r.headers['x-frame-options'] || r.headers['content-security-policy']);
  assert.equal((await request(app).get('/api/health').set('X-Request-Id', 'trace-123')).headers['x-request-id'], 'trace-123', 'caller request ids are honoured for tracing');
});
test('unknown routes return JSON 404; malformed / oversized bodies are handled, not crashes', async () => {
  assert.equal((await request(app).get('/api/nope')).status, 404);
  const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json'); assert.equal(bad.status, 400);
  const big = await request(app).post('/api/auth/login').send({ email: 'a@b.com', password: 'x'.repeat(3 * 1024 * 1024) }); assert.equal(big.status, 413);
});
test('every admin route family refuses anonymous, customer and malformed tokens', async () => {
  const paths = ['dashboard/overview', 'orders', 'payments', 'returns', 'customers', 'products', 'inventory', 'coupons', 'abandoned-carts', 'suppliers', 'quotations', 'purchase-orders', 'analytics', 'integrations', 'settings', 'tax', 'subscribers', 'notifications', 'audit', 'notification-log', 'system/health'];
  for (const p of paths) {
    assert.equal((await request(app).get('/api/admin/' + p)).status, 401, `${p}: anonymous`);
    assert.equal((await request(app).get('/api/admin/' + p).set('Authorization', 'Bearer garbage')).status, 401, `${p}: garbage token`);
    assert.equal((await request(app).get('/api/admin/' + p).set('Authorization', 'Bearer ' + customerToken())).status, 403, `${p}: a CUSTOMER token must never open admin APIs`);
    assert.equal((await request(app).get('/api/admin/' + p).set('Authorization', 'Bearer ' + jwt.sign({ sub: 'x', type: 'admin' }, 'wrong-secret'))).status, 401, `${p}: forged token`);
  }
  for (const m of ['post', 'put', 'delete']) assert.equal((await request(app)[m]('/api/admin/orders/64b000000000000000000009/status')).status, 401);
});
test('customer-only routes need a customer token (an admin token is not accepted)', async () => {
  for (const [m, p] of [['get', '/api/customers/me'], ['get', '/api/customers/me/orders'], ['get', '/api/customers/me/updates'], ['post', '/api/returns'], ['get', '/api/returns/mine'], ['get', '/api/returns/eligible/64b000000000000000000009']]) {
    assert.equal((await request(app)[m](p)).status, 401, p + ' anonymous');
    assert.equal((await request(app)[m](p).set('Authorization', 'Bearer ' + adminToken())).status, 401, p + ' with an admin token');
  }
});
test('login input validation happens before any lookup', async () => {
  assert.equal((await request(app).post('/api/auth/login').send({})).status, 400);
  assert.equal((await request(app).post('/api/auth/login').send({ email: { $ne: null }, password: { $ne: null } })).status, 400, 'operator injection is stripped, leaving empty fields');
});
test('OTP send endpoint is rate-limited per IP (cuts off SMS-bombing)', async () => {
  const statuses = []; for (let i = 0; i < 12; i++) statuses.push((await request(app).post('/api/customers/otp/send').send({ phone: '9876543210' })).status);
  assert.ok(statuses.slice(0, 10).every((s) => s !== 429), 'first 10 allowed through to the handler'); assert.equal(statuses[10], 429); assert.equal(statuses[11], 429);
});
test('CORS: production only allows the listed origins', async () => {
  const prev = { e: process.env.NODE_ENV, c: process.env.CORS_ORIGIN };
  process.env.NODE_ENV = 'production'; process.env.CORS_ORIGIN = 'https://thecraftlab.co.in,https://www.thecraftlab.co.in';
  const prod = createApp();
  assert.equal((await request(prod).get('/api/health').set('Origin', 'https://thecraftlab.co.in')).headers['access-control-allow-origin'], 'https://thecraftlab.co.in');
  const evil = await request(prod).get('/api/health').set('Origin', 'https://evil.example'); assert.equal(evil.status, 403); assert.equal(evil.headers['access-control-allow-origin'], undefined);
  assert.notEqual((await request(prod).get('/api/health')).status, 403, 'no Origin header (webhooks, uptime checks) is fine');
  process.env.NODE_ENV = prev.e; if (prev.c === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = prev.c;
});
test('REGRESSION: Razorpay webhook is reachable at /api/webhooks/razorpay and verifies its signature', async () => {
  setPaymentProvider(razorpayProvider({ keyId: 'k', keySecret: 's', webhookSecret: 'whsec', client: {} }));
  const body = JSON.stringify({ event: 'payment.captured', payload: {} });
  const none = await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').send(body); assert.equal(none.status, 400); assert.match(none.body.error, /signature/i);
  const bad = await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', 'deadbeef').send(body); assert.equal(bad.status, 400);
  const sig = crypto.createHmac('sha256', 'whsec').update(body).digest('hex');
  const good = await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', sig).set('x-razorpay-event-id', 'evt_1').send(body);
  assert.notEqual(good.status, 400, 'a correctly signed webhook gets past signature verification (it then needs the database)');
  assert.equal((await request(app).post('/api/webhooks/razorpay/razorpay').set('x-razorpay-signature', sig).send(body)).status, 404, 'the old, wrong nested path is gone');
});
test('checkout verify rejects an unsigned/forged payment confirmation', async () => {
  setPaymentProvider(razorpayProvider({ keyId: 'k', keySecret: 's', webhookSecret: 'w', client: {} }));
  const r = await request(app).post('/api/payments/verify').send({ orderId: '64b000000000000000000009', razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'forged' });
  assert.equal(r.status, 400); assert.match(r.body.error, /signature/i);
  assert.equal((await request(app).post('/api/payments/verify').send({})).status, 400);
});
test('courier webhook refuses callers without the shared token', async () => {
  const r = await request(app).post('/api/webhooks/courier/shiprocket').send({ awb: 'X', current_status: 'DELIVERED' });
  assert.ok([401, 500].includes(r.status)); assert.notEqual(r.status, 200, 'must never accept an unauthenticated tracking push');
});

/* ---------------- models (real Mongoose validation, no DB) ---------------- */
test('models: order status enum, legacy return statuses, purchase-order maths, settings defaults', () => {
  const Order = require('../src/models/Order'), Return = require('../src/models/Return'), PO = require('../src/models/PurchaseOrder'), Settings = require('../src/models/Settings');
  const base = { orderNumber: 'CL-1', customer: { name: 'A', phone: '+919876543210', email: 'A@B.com' }, address: { line1: 'x', city: 'c', state: 's', pincode: '600001' }, items: [{ product: new mongoose.Types.ObjectId(), name: 'n', sku: 's', price: 1, qty: 1 }], subtotal: 1, total: 1 };
  assert.equal(new Order({ ...base, orderStatus: 'OutForDelivery' }).validateSync(), undefined);
  assert.ok(new Order({ ...base, orderStatus: 'Teleported' }).validateSync().errors.orderStatus);
  assert.equal(new Order(base).customer.email, 'a@b.com', 'emails are lower-cased');
  assert.equal(new Order(base).toJSON().payment.razorpaySignature, undefined, 'signature never leaves the server');
  const r = { order: new mongoose.Types.ObjectId(), orderNumber: 'CL-1', reason: 'x' };
  for (const s of ['REQUESTED', 'REFUND_PENDING', 'Requested', 'PickedUp']) assert.equal(new Return({ ...r, status: s }).validateSync(), undefined, s);
  assert.ok(new Return({ ...r, status: 'WHATEVER' }).validateSync().errors.status);
  const po = new PO({ poNumber: 'PO-1', supplier: new mongoose.Types.ObjectId(), supplierName: 'S', items: [{ description: 'x', qty: 10, unitCost: 100 }], invoice: { number: 'I1', amount: 900, verified: true }, payments: [{ amount: 400 }] });
  assert.deepEqual([po.total, po.payable, po.paid, po.outstanding, po.paymentStatus], [1000, 900, 400, 500, 'PartiallyPaid'], 'a verified invoice amount overrides the PO total');
  const s = new Settings({}); assert.deepEqual([s.guestCheckoutEnabled, s.customerLoginEnabled, s.otpEnabled, s.requireMobileVerification, s.codEnabled, s.otpProvider], [true, true, true, false, false, 'none']);
});
test('integration secrets are encrypted at rest and never exposed to the browser', () => {
  process.env.SECRETS_KEY = 'a-long-test-passphrase-123';
  const Integration = require('../src/models/Integration');
  const i = new Integration({ provider: 'shiprocket', kind: 'courier' });
  i.setSecrets({ email: 'ops@thecraftlab.co.in', password: 'Sup3r-Secret-Pass' });
  assert.ok(!i.secretsEnc.includes('Sup3r') && !i.secretsEnc.includes('ops@')); assert.deepEqual(i.getSecrets(), { email: 'ops@thecraftlab.co.in', password: 'Sup3r-Secret-Pass' });
  const pub = JSON.stringify(i.toPublic()); assert.ok(!pub.includes('Sup3r') && !pub.includes('secretsEnc')); assert.match(pub, /••••Pass/);
  i.setSecrets({ password: '   ' }); assert.equal(i.getSecrets().password, 'Sup3r-Secret-Pass', 'blank field keeps the stored secret');
  i.setSecrets({ password: 'N3w-Pass-9999' }); assert.equal(i.getSecrets().password, 'N3w-Pass-9999');
  delete process.env.SECRETS_KEY; assert.throws(() => new Integration({ provider: 'x', kind: 'courier' }).setSecrets({ a: 'b' }), /SECRETS_KEY/);
});
