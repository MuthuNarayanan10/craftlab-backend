const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('http');
const U = '../src/utils/';
const { issueRefund, applyRefundStatus, RefundError } = require(U + 'refundService');
const { shiprocketProvider } = require(U + 'courier/shiprocket');
const { normalizeCourierStatus } = require(U + 'courier/status');
const { getCourier, listCouriers } = require(U + 'courier');
const { applyTrackingUpdate } = require(U + 'trackingUpdate');
const { resolveRange, computeAnalytics } = require(U + 'analytics');
const N = require(U + 'notifications');

const paid = (o = {}) => ({ orderNumber: 'CL-1', total: 2499, paymentStatus: 'Paid', orderStatus: 'Delivered', payment: { method: '', razorpayPaymentId: 'pay_1' }, refunds: [], refundedAmount: 0, events: [], ...o });

/* ---------------- refunds ---------------- */
test('refund: online partial then remainder; amount guard; status; event', async () => {
  const calls = []; const provider = { refund: async (id, o) => { calls.push({ id, o }); return { id: 'rfnd_' + calls.length, status: 'pending' }; } };
  const o = paid();
  const r1 = await issueRefund(o, { amount: 1000, reason: 'damaged', actor: 'a@x.com' }, provider);
  assert.equal(r1.refundId, 'rfnd_1'); assert.equal(o.refundedAmount, 1000); assert.equal(o.paymentStatus, 'Paid');
  assert.equal(calls[0].id, 'pay_1'); assert.equal(calls[0].o.amountRupees, 1000); assert.match(calls[0].o.receipt, /^rf_CL-1_1$/);
  await assert.rejects(issueRefund(o, { amount: 2000 }, provider), (e) => e instanceof RefundError && /1499/.test(e.message));
  await issueRefund(o, { amount: 1499 }, provider);
  assert.equal(o.paymentStatus, 'Refunded'); assert.equal(o.refundedAmount, 2499); assert.ok(o.events.length === 2);
  await assert.rejects(issueRefund(o, { amount: 1 }, provider), /refundable/);
});
test('refund: duplicate protection per return, and zero/negative/NaN rejected', async () => {
  const provider = { refund: async () => ({ id: 'r', status: 'pending' }) }; const o = paid();
  await issueRefund(o, { amount: 500, returnId: 'ret1' }, provider);
  await assert.rejects(issueRefund(o, { amount: 500, returnId: 'ret1' }, provider), (e) => e.status === 409);
  for (const bad of [0, -5, NaN, 'abc', null]) await assert.rejects(issueRefund(paid(), { amount: bad }, provider), RefundError);
});
test('refund: COD needs a manual reference; unpaid and provider errors are handled', async () => {
  const provider = { refund: async () => { throw { error: { description: 'Payment not captured' } }; } };
  const cod = paid({ payment: { method: 'cod' } });
  await assert.rejects(issueRefund(cod, { amount: 100 }, provider), /how you refunded/);
  const rec = await issueRefund(cod, { amount: 100, reference: 'UPI-123' }, provider); assert.equal(rec.method, 'manual'); assert.equal(rec.status, 'processed');
  await assert.rejects(issueRefund(paid({ paymentStatus: 'Pending' }), { amount: 10 }, provider), /no confirmed payment/);
  await assert.rejects(issueRefund(paid(), { amount: 10 }, provider), (e) => e.status === 502 && /Payment not captured/.test(e.message));
});
test('refund webhook status updates: processed / failed restores the amount', async () => {
  const provider = { refund: async () => ({ id: 'rfnd_9', status: 'pending' }) }; const o = paid();
  await issueRefund(o, { amount: 2499 }, provider); assert.equal(o.paymentStatus, 'Refunded');
  assert.equal(applyRefundStatus(o, 'rfnd_9', 'failed'), true);
  assert.equal(o.refundedAmount, 0); assert.equal(o.paymentStatus, 'Paid', 'a failed refund un-refunds the order');
  assert.equal(applyRefundStatus(o, 'rfnd_9', 'failed'), false, 'idempotent');
  assert.equal(applyRefundStatus(o, 'nope', 'processed'), false);
});

/* ---------------- courier ---------------- */
test('courier status normaliser', () => {
  const cases = { 'Out For Delivery': 'out_for_delivery', 'DELIVERED': 'delivered', 'Undelivered - consignee not available': 'exception', 'In Transit - Reached Chennai Hub': 'in_transit', 'Picked Up': 'picked_up', 'Pickup Scheduled': 'pickup_scheduled', 'RTO Initiated': 'rto', 'Shipment Cancelled': 'cancelled', '': null, 'gibberish': null };
  for (const [k, v] of Object.entries(cases)) assert.equal(normalizeCourierStatus(k), v, k);
});
test('courier registry: manual always available; unknown rejected; new couriers plug in', () => {
  assert.equal(getCourier('manual').supportsApi, false); assert.throws(() => getCourier('nope'), /Unknown courier/);
  assert.deepEqual(listCouriers().map((c) => c.id), ['manual', 'shiprocket']);
});

function mockShiprocket(behaviour = {}) {
  const log = []; let logins = 0;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const json = body ? JSON.parse(body) : {}; log.push({ method: req.method, url: req.url, auth: req.headers.authorization, json });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/auth/login') { logins++; return json.password === 'good' ? send(200, { token: 'tok' + logins }) : send(401, { message: 'Invalid credentials' }); }
      if (behaviour.expireFirst && !behaviour._expired && req.url.startsWith('/orders/create')) { behaviour._expired = true; return send(401, { message: 'token expired' }); }
      if (req.url === '/orders/create/adhoc') return send(200, { order_id: 111, shipment_id: 222 });
      if (req.url === '/courier/assign/awb') return behaviour.awbFails ? send(422, { message: 'No courier serviceable' }) : send(200, { response: { data: { awb_code: 'AWB123', courier_name: 'Delhivery' } } });
      if (req.url === '/courier/generate/pickup') return send(200, { response: { pickup_scheduled_date: '2026-10-05' } });
      if (req.url === '/courier/generate/label') return send(200, { label_url: 'https://labels/222.pdf' });
      if (req.url.startsWith('/courier/track/awb/')) return send(200, { tracking_data: { track_url: 'https://track/AWB123', etd: '2026-10-09', shipment_track_activities: [{ activity: 'Out For Delivery', location: 'Chennai', date: '2026-10-08 09:00:00' }, { activity: 'In Transit', location: 'Hub', date: '2026-10-07 09:00:00' }] } });
      if (req.url.startsWith('/courier/serviceability')) return send(200, { data: { available_courier_companies: [{ courier_company_id: 1, courier_name: 'Delhivery', rate: 80, etd: '3 days' }] } });
      if (req.url === '/orders/cancel') return send(200, { message: 'cancelled' });
      send(404, { message: 'nf' });
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, log, base: `http://127.0.0.1:${server.address().port}`, logins: () => logins })));
}
const orderFixture = () => ({ orderNumber: 'CL-77', createdAt: new Date(), total: 2499, customer: { name: 'Muthu Natha Narayanan', phone: '+919500177909', email: 'a@b.com' }, address: { line1: '1 Test St', line2: 'Near park', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' }, items: [{ name: 'Rack', sku: 'S1', qty: 1, price: 2499 }], payment: { method: 'cod' } });

test('shiprocket: full flow order → AWB → pickup → label, correct payload', async () => {
  const m = await mockShiprocket(); const sr = shiprocketProvider({ baseUrl: m.base });
  const creds = { email: 'a@b.com', password: 'good' };
  assert.deepEqual(await sr.testConnection(creds), { ok: true, message: 'Connected to Shiprocket.' });
  const r = await sr.createShipment(creds, orderFixture(), { pickupLocation: 'Primary', defaultWeightKg: 2 });
  assert.equal(r.awb, 'AWB123'); assert.equal(r.courierName, 'Delhivery'); assert.equal(r.labelUrl, 'https://labels/222.pdf'); assert.equal(r.providerOrderId, '111'); assert.equal(r.shipmentId, '222'); assert.deepEqual(r.warnings, []);
  const create = m.log.find((l) => l.url === '/orders/create/adhoc');
  assert.equal(create.auth, 'Bearer tok1'); assert.equal(create.json.payment_method, 'COD'); assert.equal(create.json.billing_phone, '9500177909'); assert.equal(create.json.billing_customer_name, 'Muthu'); assert.equal(create.json.billing_last_name, 'Natha Narayanan'); assert.equal(create.json.pickup_location, 'Primary'); assert.equal(create.json.weight, 2); assert.equal(create.json.order_items[0].units, 1);
  assert.equal(m.logins(), 1, 'token reused across steps'); m.server.close();
});
test('shiprocket: AWB failure keeps the shipment (retryable) with a warning; bad credentials rejected; 401 refreshes token', async () => {
  let m = await mockShiprocket({ awbFails: true }); let sr = shiprocketProvider({ baseUrl: m.base });
  const r = await sr.createShipment({ email: 'a@b.com', password: 'good' }, orderFixture(), { pickupLocation: 'P' });
  assert.equal(r.shipmentId, '222'); assert.equal(r.awb, ''); assert.match(r.warnings[0], /AWB.*No courier serviceable/); assert.ok(!m.log.some((l) => l.url.includes('pickup')), 'no pickup without an AWB'); m.server.close();
  m = await mockShiprocket(); sr = shiprocketProvider({ baseUrl: m.base });
  await assert.rejects(sr.testConnection({ email: 'x', password: 'bad' }), /Invalid credentials/);
  await assert.rejects(sr.createShipment({ email: 'a@b.com', password: 'good' }, orderFixture(), {}), /pickup location/i); m.server.close();
  m = await mockShiprocket({ expireFirst: true }); sr = shiprocketProvider({ baseUrl: m.base });
  const ok = await sr.createShipment({ email: 'a@b.com', password: 'good' }, orderFixture(), { pickupLocation: 'P' }); assert.equal(ok.awb, 'AWB123'); assert.equal(m.logins(), 2, 'logged in again after the 401'); m.server.close();
});
test('shiprocket: track, serviceability, cancel, webhook parsing', async () => {
  const m = await mockShiprocket(); const sr = shiprocketProvider({ baseUrl: m.base }); const c = { email: 'a@b.com', password: 'good' };
  const t = await sr.track(c, 'AWB123'); assert.equal(t.status, 'out_for_delivery'); assert.equal(t.location, 'Chennai'); assert.equal(t.trackingUrl, 'https://track/AWB123'); assert.ok(t.etd instanceof Date); assert.equal(t.activities.length, 2);
  const s = await sr.serviceability(c, { pickupPin: '600001', deliveryPin: '560001', cod: true }); assert.equal(s.serviceable, true); assert.equal(s.couriers[0].name, 'Delhivery');
  assert.deepEqual(await sr.cancel(c, '111'), { ok: true });
  assert.deepEqual({ ...sr.parseWebhook({ awb: 'A1', current_status: 'DELIVERED', current_timestamp: '2026-10-08 10:00:00' }), at: undefined }, { awb: 'A1', rawStatus: 'DELIVERED', status: 'delivered', location: '', at: undefined });
  m.server.close();
});

/* ---------------- tracking → order status ---------------- */
test('tracking update walks forward only, handles skipped states, deliver/ETA/alerts', () => {
  const o = { orderStatus: 'Packed', paymentStatus: 'Paid', payment: { method: '' }, events: [], shipment: {}, delivery: {} };
  let r = applyTrackingUpdate(o, { status: 'picked_up', rawStatus: 'Picked Up', at: new Date('2026-10-05') });
  assert.equal(o.orderStatus, 'Dispatched'); assert.ok(r.changed); assert.ok(o.delivery.dispatchDate);
  r = applyTrackingUpdate(o, { status: 'picked_up', rawStatus: 'Picked Up' }); assert.equal(r.changed, false, 'idempotent');
  r = applyTrackingUpdate(o, { status: 'delivered', rawStatus: 'Delivered', location: 'Chennai', etd: new Date('2026-10-09') });
  assert.equal(o.orderStatus, 'Delivered'); assert.ok(o.deliveredAt); assert.deepEqual(o.events.map((e) => e.stage), ['handed', 'transit', 'out', 'delivered'], 'skipped states are filled in order');
  applyTrackingUpdate(o, { status: 'in_transit', rawStatus: 'In transit' }); assert.equal(o.orderStatus, 'Delivered', 'never goes backwards');
  const o2 = { orderStatus: 'InTransit', paymentStatus: 'Paid', payment: {}, events: [], shipment: {} };
  r = applyTrackingUpdate(o2, { status: 'exception', rawStatus: 'Undelivered - address issue' }); assert.equal(o2.orderStatus, 'InTransit'); assert.equal(r.alert, 'exception');
  r = applyTrackingUpdate(o2, { status: 'exception', rawStatus: 'Undelivered - address issue' }); assert.equal(r.changed, false, 'same alert not repeated');
  const unpaid = { orderStatus: 'Pending', paymentStatus: 'Pending', payment: {}, events: [], shipment: {} };
  applyTrackingUpdate(unpaid, { status: 'delivered', rawStatus: 'Delivered' }); assert.equal(unpaid.orderStatus, 'Pending', 'courier events cannot fulfil an unpaid order');
});

/* ---------------- analytics ---------------- */
test('analytics: ranges use India-time day boundaries', () => {
  const now = new Date('2026-10-04T20:00:00Z'); // 01:30 IST on 5 Oct
  const t = resolveRange({ range: 'today' }, now); assert.equal(t.from.toISOString(), '2026-10-04T18:30:00.000Z'); assert.equal(t.to.toISOString(), '2026-10-05T18:29:59.999Z');
  const w = resolveRange({ range: '7d' }, now); assert.equal(Math.round((w.to - w.from) / 86400e3), 7);
  assert.equal(resolveRange({ range: 'custom', from: '2026-09-01', to: '2026-09-10' }, now).label, 'custom');
  assert.throws(() => resolveRange({ range: 'custom', from: '2026-09-10', to: '2026-09-01' }, now), /valid date range/);
  assert.throws(() => resolveRange({ range: 'custom', from: '2024-01-01', to: '2026-09-01' }, now), /too long/);
  assert.equal(resolveRange({ range: 'weird' }, now).label, '30d');
});
test('analytics: revenue, refunds, customers, returns, payment failures, couriers, sources', () => {
  const D = (s) => new Date(s + 'T10:00:00+05:30');
  const orders = [
    { createdAt: D('2026-10-01'), paymentStatus: 'Paid', orderStatus: 'Delivered', total: 2500, payment: { method: '' }, customer: { phone: '+919000000001' }, items: [{ name: 'A', qty: 1, price: 2500 }], attribution: { source: 'instagram' }, shipment: { courierName: 'Delhivery' }, events: [{ stage: 'handed', at: D('2026-10-02') }, { stage: 'delivered', at: D('2026-10-05') }], refunds: [{ amount: 500, status: 'processed', createdAt: D('2026-10-06') }] },
    { createdAt: D('2026-10-02'), paymentStatus: 'Paid', orderStatus: 'Dispatched', total: 3500, payment: { method: 'cod' }, customer: { phone: '+919000000002' }, items: [{ name: 'B', qty: 2, price: 1750 }], events: [] },
    { createdAt: D('2026-10-03'), paymentStatus: 'Pending', orderStatus: 'Cancelled', total: 2500, payment: { method: '' }, customer: { phone: '+919000000003' }, items: [{ name: 'A', qty: 1, price: 2500 }], events: [] },
    { createdAt: D('2026-10-04'), paymentStatus: 'Paid', orderStatus: 'Paid', total: 1000, payment: { method: '' }, customer: { phone: '+919000000001' }, items: [{ name: 'A', qty: 1, price: 1000 }], events: [] },
  ];
  const returns = [{ createdAt: D('2026-10-06'), items: [{ name: 'A', qty: 1 }] }];
  const range = resolveRange({ range: 'custom', from: '2026-10-01', to: '2026-10-07' }, new Date('2026-10-08'));
  const a = computeAnalytics({ orders, returns, ...range, priorPhones: new Set(['9000000001']) });
  assert.equal(a.revenue, 7000); assert.equal(a.refundAmount, 500); assert.equal(a.netRevenue, 6500); assert.equal(a.avgOrderValue, 2333.33);
  assert.deepEqual(a.orders, { placed: 4, paid: 3, cancelled: 1, cod: 1, delivered: 1 });
  assert.deepEqual(a.customers, { new: 1, returning: 1 }, 'phone …001 existed before the range; …002 is new');
  assert.deepEqual(a.products.map((p) => [p.name, p.revenue]).sort(), [['A', 3500], ['B', 3500]]); assert.equal(a.products.find((p) => p.name === 'A').returned, 1); assert.equal(a.products.find((p) => p.name === 'B').units, 2);
  assert.deepEqual(a.returns, { count: 1, rate: 100 }); assert.deepEqual(a.payments, { onlineAttempts: 3, failedOrAbandoned: 1, failureRate: 33.33 });
  assert.deepEqual(a.couriers, [{ name: 'Delhivery', shipments: 1, avgDeliveryDays: 3 }]); assert.equal(a.sources.find((s) => s.source === 'instagram').revenue, 2500); assert.equal(a.sources.find((s) => s.source === 'direct').orders, 2);
  assert.equal(a.daily.length, 7); assert.equal(a.daily.find((d) => d.date === '2026-10-01').revenue, 2500); assert.equal(a.conversion, null);
});

/* ---------------- notifications ---------------- */
function memLog() { const rows = []; let n = 0; return { rows,
  claim: async (key, doc) => { if (rows.some((r) => r.key === key)) return null; const r = { id: ++n, key, attempts: 0, ...doc }; rows.push(r); return r; },
  update: async (id, patch) => { const r = rows.find((x) => x.id === id); const { $inc, ...rest } = patch; Object.assign(r, rest); if ($inc) for (const k in $inc) r[k] = (r[k] || 0) + $inc[k]; },
  findFailed: async () => rows.filter((r) => r.status === 'failed' && r.attempts < 3) }; }
const ord = { orderNumber: 'CL-9', total: 2499, customer: { name: 'Muthu N', phone: '+919500177909', email: 'a@b.com' }, payment: { method: '' }, delivery: { partner: 'Delhivery', trackingId: 'T1' } };

test('notifications: message content, dedupe per event/channel, disabled channels skipped', async () => {
  const sent = []; const logStore = memLog();
  const ch = { email: { send: async (m) => sent.push(['email', m.to, m.subject]) }, whatsapp: { send: async (m) => sent.push(['wa', m.to, m.text]) } };
  const nf = N.createNotifier({ logStore, channels: ch, enabled: (c) => c !== 'whatsapp' });
  assert.deepEqual(await nf.notify('order_shipped', { order: ord }), { email: 'sent' });
  assert.deepEqual(await nf.notify('order_shipped', { order: ord }), { email: 'duplicate' }); assert.equal(sent.length, 1);
  assert.match(sent[0][2], /Order shipped — CL-9/); assert.equal(sent[0][1], 'a@b.com');
  const both = N.createNotifier({ logStore: memLog(), channels: ch, enabled: () => true });
  await both.notify('out_for_delivery', { order: ord }); const wa = sent.find((s) => s[0] === 'wa'); assert.equal(wa[1], '+919500177909'); assert.match(wa[2], /out for delivery.*order-tracking\.html\?order=CL-9/s);
  assert.throws(() => N.buildMessage('nope', { order: ord }), /Unknown notification/);
  const html = N.buildMessage('delivered', { order: { ...ord, customer: { ...ord.customer, name: '<script>x</script>' } } }).html; assert.ok(!html.includes('<script>x'), 'names are escaped in email html');
});
test('notifications: refund events are keyed per refund; failures logged and retried', async () => {
  const logStore = memLog(); let fail = true; const ch = { email: { send: async () => { if (fail) throw new Error('smtp down'); } } };
  const nf = N.createNotifier({ logStore, channels: ch, enabled: () => true });
  assert.deepEqual(await nf.notify('refund_initiated', { order: ord, refund: { refundId: 'r1', amount: 100 } }), { email: 'failed' });
  assert.equal(logStore.rows[0].status, 'failed'); assert.match(logStore.rows[0].error, /smtp down/);
  assert.deepEqual(await nf.notify('refund_initiated', { order: ord, refund: { refundId: 'r2', amount: 50 } }), { email: 'failed' }, 'a different refund is a different notification');
  fail = false; assert.equal(await nf.retryFailed(), 2); assert.ok(logStore.rows.every((r) => r.status === 'sent'));
  assert.equal(await nf.retryFailed(), 0);
});
test('notifications: an unconfigured channel is recorded as skipped (not failed) and never retried', async () => {
  const logStore = memLog(); const ch = { email: { send: async () => { throw Object.assign(new Error('Email is not configured'), { skipped: true }); } } };
  const nf = N.createNotifier({ logStore, channels: ch, enabled: () => true });
  assert.deepEqual(await nf.notify('order_placed', { order: ord }), { email: 'skipped' }); assert.equal(logStore.rows[0].status, 'skipped'); assert.equal(await nf.retryFailed(), 0);
});
test('whatsapp cloud adapter: template payload; API errors surface', async () => {
  const calls = []; const ok = N.whatsappCloudChannel({ phoneNumberId: '123', accessToken: 'T', templateName: 'order_update', fetchImpl: async (u, i) => { calls.push({ u, i }); return { ok: true }; } });
  await ok.send({ to: '+919500177909', text: 'line1\nline2', order: ord });
  const body = JSON.parse(calls[0].i.body); assert.equal(calls[0].u, 'https://graph.facebook.com/v19.0/123/messages'); assert.equal(body.to, '919500177909'); assert.equal(body.template.name, 'order_update'); assert.deepEqual(body.template.components[0].parameters.map((p) => p.text), ['Muthu', 'CL-9', 'line1 line2']); assert.equal(calls[0].i.headers.Authorization, 'Bearer T');
  const bad = N.whatsappCloudChannel({ phoneNumberId: '1', accessToken: 'T', templateName: 't', fetchImpl: async () => ({ ok: false, json: async () => ({ error: { message: 'Template not approved' } }) }) });
  await assert.rejects(bad.send({ to: '+91', text: 'x', order: ord }), /Template not approved/);
});
