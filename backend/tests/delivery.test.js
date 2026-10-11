const test = require('node:test'); const assert = require('node:assert/strict');
const D = require('../src/utils/delivery'); const { buildJourney } = require('../src/utils/orderStatus'); const N = require('../src/utils/notifications');

const std = { key: 'standard', name: 'Standard', type: 'courier', enabled: true, fee: 99, freeAbove: 2000, etaMinDays: 5, etaMaxDays: 7, codAllowed: true, sortOrder: 1 };
const exp = { key: 'express', name: 'Express', type: 'courier', enabled: true, fee: 149, freeAbove: 0, etaMinDays: 2, etaMaxDays: 3, codAllowed: false, sortOrder: 2 };
const local = { key: 'manual', name: 'Local', type: 'manual', enabled: true, fee: 40, etaMinDays: 0, etaMaxDays: 1, codAllowed: true, sortOrder: 3, pincodePrefixes: ['600', '601'], pincodes: ['603110'] };

test('serviceability: empty lists = everywhere; prefixes and exact PINs; junk rejected', () => {
  assert.equal(D.isServiceable(std, '560001'), true); assert.equal(D.isServiceable(std, '5600'), false); assert.equal(D.isServiceable(std, ''), false);
  assert.equal(D.isServiceable(local, '600042'), true); assert.equal(D.isServiceable(local, '601201'), true); assert.equal(D.isServiceable(local, '603110'), true, 'exact PIN outside the prefixes'); assert.equal(D.isServiceable(local, '560001'), false);
  assert.equal(D.isServiceable(local, '600 042'), true, 'spaces tolerated');
});
test('fees: flat, free above a threshold, never negative', () => {
  assert.equal(D.feeFor(std, 1999), 99); assert.equal(D.feeFor(std, 2000), 0); assert.equal(D.feeFor(exp, 99999), 149, 'no threshold set = never free'); assert.equal(D.feeFor({ fee: -5 }, 10), 0); assert.equal(D.feeFor({ fee: 'x' }, 10), 0);
});
test('ETA wording', () => { assert.equal(D.etaText(std), '5–7 days'); assert.equal(D.etaText(local), 'Within 1 day'); assert.equal(D.etaText({ etaMaxDays: 4 }), '4 days'); assert.equal(D.etaText({}), 'Ready soon'); });
test('applicable options: enabled + serviceable only, priced, COD marked selectable or not, sorted', () => {
  const off = { ...exp, key: 'off', enabled: false };
  const r = D.applicableMethods([local, exp, std, off], { pincode: '600001', subtotal: 2500, cod: false });
  assert.deepEqual(r.map((x) => x.key), ['standard', 'express', 'manual']); assert.equal(r[0].fee, 0, 'standard free above ₹2000'); assert.equal(r[1].fee, 149);
  assert.deepEqual(D.applicableMethods([local, exp, std], { pincode: '560001', subtotal: 100 }).map((x) => x.key), ['standard', 'express'], 'local delivery hidden outside its area');
  const cod = D.applicableMethods([std, exp], { pincode: '600001', subtotal: 100, cod: true }); assert.deepEqual(cod.map((x) => x.selectable), [true, false]);
  assert.equal(D.applicableMethods([std, exp, local], { subtotal: 100 }).length, 3, 'before a PIN is known, everything enabled is shown');
});
test('snapshot freezes what the customer was quoted', () => {
  const s = D.snapshot(std, 1500); assert.deepEqual(s, { key: 'standard', name: 'Standard', type: 'courier', fee: 99, etaMinDays: 5, etaMaxDays: 7, courierProvider: '' });
  const e = D.estimatedDate(std, new Date('2026-10-01T00:00:00Z')); assert.equal(e.toISOString().slice(0, 10), '2026-10-08'); assert.equal(D.estimatedDate({ etaMaxDays: 0 }), null);
});
test('journey + messages for MANUAL delivery: our team, no AWB, delivery person shown, phone only when out for delivery', () => {
  const base = { orderNumber: 'CL-5', total: 100, paymentStatus: 'Paid', payment: { method: '' }, events: [], customer: { name: 'Asha K' }, shipment: { awb: 'SHOULD-NOT-SHOW', trackingUrl: 'http://x' }, delivery: { method: { key: 'manual', type: 'manual', name: 'Local', etaMinDays: 1, etaMaxDays: 2 }, assignee: { name: 'Rajan', phone: '+919000000009' }, scheduledFor: new Date('2026-10-06T10:00:00Z') } };
  let j = buildJourney({ ...base, orderStatus: 'Packed' }); assert.equal(j.stages[4].label, 'Handed to our delivery team'); assert.equal(j.courier.name, 'Our delivery team'); assert.equal(j.courier.awb, '', 'a courier AWB never shows for our own deliveries'); assert.equal(j.courier.trackingUrl, '');
  assert.deepEqual(j.assignee, { name: 'Rajan', phone: '' }, 'phone stays hidden until the order is out'); assert.equal(j.deliveryMethod.type, 'manual'); assert.match(j.deliveryWindowText, /1–2 days after dispatch/);
  j = buildJourney({ ...base, orderStatus: 'OutForDelivery' }); assert.equal(j.assignee.phone, '+919000000009');
  const out = N.buildMessage('out_for_delivery', { order: { ...base, orderStatus: 'OutForDelivery' } }).text; assert.match(out, /with Rajan \(\+919000000009\)/);
  assert.match(N.buildMessage('order_shipped', { order: base }).text, /with our delivery team and is planned for/); assert.ok(!/courier|AWB/i.test(N.buildMessage('order_shipped', { order: base }).text));
  const courier = N.buildMessage('order_shipped', { order: { ...base, delivery: { method: { type: 'courier' }, partner: 'Delhivery', trackingId: 'T1' }, shipment: {} } }).text; assert.match(courier, /handed to the courier \(Delhivery\)/);
  assert.equal(buildJourney({ ...base, delivery: {}, orderStatus: 'Packed' }).courier.name, '', 'orders without a method (older orders) still render');
});

test('Delhivery adapter: creates a waybill from the documented form payload, schedules pickup, tracks, cancels and parses webhooks (fake HTTP)', async () => {
  const { delhiveryProvider } = require('../src/utils/courier/delhivery'); const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body }); const u = String(url);
    const json = (o, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(o) });
    if (u.includes('/api/cmu/create.json')) return json({ success: true, packages: [{ status: 'Success', waybill: '1234567890123', remarks: [] }] });
    if (u.includes('/fm/request/new/')) return json({ pickup_id: 77 });
    if (u.includes('/api/p/packing_slip')) return json({ packages: [{ pdf_download_link: 'https://labels.test/d.pdf' }] });
    if (u.includes('/api/v1/packages/json/')) return json({ ShipmentData: [{ Shipment: { AWB: '1234567890123', Status: { Status: 'In Transit', StatusLocation: 'Chennai Hub', StatusDateTime: '2026-10-11T09:00:00' }, Scans: [{ ScanDetail: { Scan: 'Manifested', ScannedLocation: 'Workshop', ScanDateTime: '2026-10-10T10:00:00' } }, { ScanDetail: { Scan: 'In Transit', ScannedLocation: 'Chennai Hub', ScanDateTime: '2026-10-11T09:00:00' } }], ExpectedDeliveryDate: '2026-10-14T00:00:00' } }] });
    if (u.includes('/api/p/edit')) return json({ status: true });
    if (u.includes('/pin-codes/json/')) return json({ delivery_codes: [{ postal_code: { pin: 600001, cod: 'Y', pre_paid: 'Y' } }] });
    return json({}, 404);
  };
  const d = delhiveryProvider({ fetchImpl: fakeFetch, baseUrl: 'https://stage.test' }); const creds = { apiToken: 'tok-1' }; const cfg = { pickupLocation: 'Workshop', defaultWeightKg: '1.5' };
  assert.equal((await d.testConnection(creds)).ok, true); assert.equal(calls[0].headers.Authorization, 'Token tok-1');
  const order = { orderNumber: 'FY2026CL010', createdAt: new Date('2026-10-10'), total: 2499, payment: { method: 'cod' }, customer: { name: 'Asha K', phone: '+91 90000 11111', email: 'a@b.co' }, address: { line1: '12 Anna Salai', line2: '', city: 'Chennai', state: 'Tamil Nadu', pincode: '600002' }, items: [{ name: 'Rack', qty: 1, price: 2499, sku: 'S1' }] };
  const r = await d.createShipment(creds, order, cfg); assert.equal(r.awb, '1234567890123'); assert.equal(r.courierName, 'Delhivery'); assert.equal(r.labelUrl, 'https://labels.test/d.pdf'); assert.ok(r.pickupScheduledAt instanceof Date);
  const create = calls.find((c) => c.url.includes('create.json')); const form = new URLSearchParams(create.body); assert.equal(form.get('format'), 'json'); const data = JSON.parse(form.get('data'));
  assert.equal(data.pickup_location.name, 'Workshop'); assert.equal(data.shipments[0].payment_mode, 'COD'); assert.equal(data.shipments[0].cod_amount, '2499'); assert.equal(data.shipments[0].pin, '600002'); assert.equal(data.shipments[0].weight, '1500'); assert.equal(data.shipments[0].phone, '9000011111');
  await assert.rejects(() => d.createShipment(creds, order, {}), /pickup location/i);
  const t = await d.track(creds, '1234567890123'); assert.equal(t.status, 'in_transit'); assert.equal(t.location, 'Chennai Hub'); assert.equal(t.activities.length, 2); assert.equal(t.activities[0].raw, 'In Transit', 'newest first');
  assert.equal((await d.cancel(creds, '1234567890123')).ok, true); assert.equal(JSON.parse(calls.find((c) => c.url.includes('/api/p/edit')).body).cancellation, 'true');
  assert.deepEqual((await d.serviceability(creds, { deliveryPin: '600001', cod: true })).serviceable, true);
  const w = d.parseWebhook({ Shipment: { AWB: '99', Status: { Status: 'Delivered', StatusLocation: 'Chennai', StatusDateTime: '2026-10-12T10:00:00' } } }); assert.equal(w.awb, '99'); assert.equal(w.status, 'delivered');
  const bad = delhiveryProvider({ fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{}' }) }); await assert.rejects(() => bad.testConnection({ apiToken: 'x' }), /token/i);
});

test('courier env helper: required variables, kill switch, stable webhook token', () => {
  const E = require('../src/utils/courier/env');
  assert.deepEqual(E.envStatus('shiprocket', {}).missing, ['SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_PICKUP_LOCATION']);
  const env = { SHIPROCKET_EMAIL: 'a@b.co', SHIPROCKET_PASSWORD: 'pw', SHIPROCKET_PICKUP_LOCATION: 'Home', JWT_SECRET: 'abc' };
  assert.equal(E.envStatus('shiprocket', env).configured, true); const c = E.courierFromEnv('shiprocket', env); assert.equal(c.creds.email, 'a@b.co'); assert.equal(c.cfg.pickupLocation, 'Home');
  assert.equal(E.webhookTokenFor('shiprocket', env), E.webhookTokenFor('shiprocket', env), 'token is stable across restarts'); assert.notEqual(E.webhookTokenFor('shiprocket', env), E.webhookTokenFor('delhivery', env));
  assert.equal(E.webhookTokenFor('shiprocket', { ...env, SHIPROCKET_WEBHOOK_TOKEN: 'mine' }), 'mine');
  assert.equal(E.courierFromEnv('shiprocket', { ...env, COURIERS_DISABLED: 'true' }), null); assert.equal(E.courierFromEnv('nope', env), null);
});
