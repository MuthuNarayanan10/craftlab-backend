/** Dev/test server: the REAL backend (all routes, all rules) + the storefront and admin served from /frontend, on a MongoDB-compatible test DB.
 *    FERRET=1 node tests/support/ui-server.js     (then open http://localhost:4000)
 *  Seeds sample data. Razorpay is faked (checkout.razorpay.com is not reachable from the browser test), the OTP provider is "dev"
 *  (the code is shown on screen in test mode), emails are skipped. NEVER use this against a real database. */
process.env.JWT_SECRET = 'ui-secret-'.repeat(4); process.env.SECRETS_KEY = 'ui-secrets-passphrase-12345'; process.env.DISABLE_JOBS = 'true'; process.env.SITE_URL = 'http://localhost:4000';
process.env.RAZORPAY_KEY_ID = 'rzp_test_ui'; process.env.NODE_ENV = 'test';
const express = require('express'); const path = require('path'); const crypto = require('crypto');
const db = require('./db');
const KEY_SECRET = 'ui_key_secret';

(async () => {
  await db.start();
  const { setPaymentProvider, razorpayProvider } = require('../../src/utils/paymentProvider');
  let n = 0; const rz = { orders: { create: async (o) => ({ id: 'order_ui' + ++n, ...o }), fetchPayments: async () => ({ items: [] }) }, payments: { refund: async (pid, o) => ({ id: 'rfnd_ui' + ++n, status: 'pending', payment_id: pid, ...o }) } };
  setPaymentProvider(razorpayProvider({ keyId: 'rzp_test_ui', keySecret: KEY_SECRET, webhookSecret: 'wh', client: rz }));
  const { createApp } = require('../../src/app');
  const outer = express();
  outer.get('/__sign', (req, res) => res.json({ sig: crypto.createHmac('sha256', KEY_SECRET).update(`${req.query.o}|${req.query.p}`).digest('hex') })); // lets the browser test fake a Razorpay success
  outer.get('/__reset-otp', async (req, res) => { await require('../../src/models/OtpRequest').collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 600e3) } }); res.json({ ok: true }); }); // test-only: skip the resend cool-down
  outer.use(express.static(path.join(__dirname, '../../../frontend')));
  outer.use(createApp());
  const server = await new Promise((res, rej) => { const sv = outer.listen(process.env.PORT || 4000, () => res(sv)); sv.on('error', rej); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const M = (m) => require('../../src/models/' + m);

  // ---- seed ----
  for (const [email, role, name] of [['owner@shop.test', 'ADMIN', 'Owner'], ['staff@shop.test', 'STAFF', 'Staff']]) { const a = new (M('Admin'))({ name, email, role }); await a.setPassword('Passw0rd!x'); await a.save(); }
  const P = M('Product');
  const p1 = await P.create({ name: 'Sculptural Wall Hook Rack', slug: 'sculptural-wall-hook-rack', sku: 'CRAFTLAB-HNG-01', category: 'Wall Organizers', shortDescription: 'A layered, sculptural wall organizer with varied-height wooden pegs.', longDescription: 'Bring natural character home. Solid wood with visible grain.', price: 2499, mrp: 2999, stock: 40, lowStockThreshold: 5, material: 'Solid wood, natural finish', dimensions: '50cm (L) x 22cm (H)', features: ['Varied heights', 'Natural grain'], careInstructions: ['Wipe with a dry cloth'], whatsIncluded: '1 x rack + hardware', images: ['images/product1-1.jpg', 'images/product1-2.jpg', 'images/product1-detail-1.jpg'] });
  const p2 = await P.create({ name: 'Classic Row Wall Hook Rack', slug: 'classic-row-wall-hook-rack', sku: 'CRAFTLAB-HNG-02', category: 'Wall Organizers', shortDescription: 'A clean, uniform row of solid wood hooks.', longDescription: 'Natural organisation for everyday living.', price: 2499, mrp: 2999, stock: 3, lowStockThreshold: 5, material: 'Solid wood', dimensions: '50cm x 20cm', features: ['Multiple hooks'], careInstructions: [], whatsIncluded: '1 x rack', images: ['images/product2-1.jpg', 'images/product2-2.jpg', 'images/product2-detail-1.jpg'] });
  const { getSettings } = M('Settings'); const st = await getSettings();
  Object.assign(st, { businessName: 'The Craft Lab', legalName: 'The Craft Lab', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', email: 'care@thecraftlab.co.in', phone: '9500000000', gstin: '33ABCDE1234F1Z5', defaultTaxRate: 18, codEnabled: true, prepaidDiscountPercent: 5, supportWhatsapp: '919876543210', otpEnabled: true, otpProvider: 'dev', returnWindowDays: 7 }); await st.save();
  await M('DeliveryMethod').ensureDefaults();
  await M('Coupon').create({ code: 'SAVE10', type: 'percentage', value: 10 });
  await M('Supplier').create({ name: 'Kerala Woodworks', contactPerson: 'Rajan', phone: '9876500000', email: 'k@w.com', status: 'active' });

  const j = async (url, opts = {}) => { const r = await fetch(base + '/api' + url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const owner = (await j('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'Passw0rd!x' } })).body.token; const A = { Authorization: 'Bearer ' + owner };
  await j('/admin/delivery/express', { method: 'PUT', headers: A, body: { enabled: true } });
  await j('/admin/delivery/manual', { method: 'PUT', headers: A, body: { enabled: true, fee: 40, pincodePrefixes: '600', etaMaxDays: 1 } });
  // a customer account (verified by OTP) so the account pages have data
  const otp = await j('/customers/otp/send', { method: 'POST', body: { phone: '9876543210' } }); const login = await j('/customers/otp/verify', { method: 'POST', body: { phone: '9876543210', code: otp.body.devCode, name: 'Muthu', termsAccepted: true } });
  const C = { Authorization: 'Bearer ' + login.body.token };
  await j('/customers/me', { method: 'PUT', headers: C, body: { email: 'muthu@example.com', addresses: [{ label: 'Home', receiverName: 'Muthu', line1: '136 Sree Devi Street', line2: 'Sree Ranga Nagar', city: 'Chengalpattu', state: 'Tamil Nadu', pincode: '603110' }] } });
  const order = async (product, qty, extra = {}, auth = C) => { const cart = (await j('/cart', { method: 'POST' })).body.cartId; await j(`/cart/${cart}/items`, { method: 'POST', body: { productId: product.id, qty } }); const r = await j('/checkout', { method: 'POST', headers: auth, body: { cartId: cart, paymentMethod: 'cod', deliveryMethod: 'standard', customer: { name: 'Muthu', phone: '9876543210', email: 'muthu@example.com' }, address: { line1: '136 Sree Devi Street', city: 'Chengalpattu', state: 'Tamil Nadu', pincode: '603110' }, ...extra } }); return r.body; };
  const status = (id, s) => j(`/admin/orders/${id}/status`, { method: 'PUT', headers: A, body: { orderStatus: s } });
  const o1 = await order(p1, 1); await status(o1.orderId, 'Packed');                                                                   // packed
  const o2 = await order(p2, 1); await status(o2.orderId, 'Packed'); await status(o2.orderId, 'Dispatched'); await j(`/admin/orders/${o2.orderId}/delivery`, { method: 'PUT', headers: A, body: { partner: 'Delhivery', trackingId: 'DL778899' } }); await status(o2.orderId, 'InTransit'); // in transit
  const o3 = await order(p1, 1, { deliveryMethod: 'manual', address: { line1: '12 Anna Salai', city: 'Chennai', state: 'Tamil Nadu', pincode: '600002' } }); await j(`/admin/orders/${o3.orderId}/delivery`, { method: 'PUT', headers: A, body: { assignee: { name: 'Rajan', phone: '9000000009' }, scheduledFor: new Date(Date.now() + 86400e3).toISOString() } }); await status(o3.orderId, 'Packed'); await status(o3.orderId, 'Dispatched'); await status(o3.orderId, 'OutForDelivery'); // manual, out for delivery
  const o4 = await order(p1, 2); for (const s of ['Packed', 'Dispatched', 'Delivered']) await status(o4.orderId, s);                  // delivered → returnable
  console.log(JSON.stringify({ ready: true, port: server.address().port, orders: { packed: o1.orderNumber, inTransit: o2.orderNumber, manualOut: o3.orderNumber, delivered: o4.orderNumber }, customerToken: login.body.token }));
})().catch((e) => { console.error('UI SERVER FAILED', e); process.exit(1); });
