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
