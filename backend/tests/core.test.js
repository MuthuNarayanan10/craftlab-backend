const test = require('node:test'); const assert = require('node:assert/strict');
const U = '../src/utils/';

test('crypto: round-trip, tamper detection, requires key', () => {
  delete process.env.SECRETS_KEY; const c = require(U + 'crypto');
  assert.throws(() => c.encrypt('x'), /SECRETS_KEY/);
  process.env.SECRETS_KEY = 'a-long-test-passphrase-123';
  const blob = c.encrypt('shiprocket-password');
  assert.notEqual(blob, 'shiprocket-password'); assert.ok(!blob.includes('shiprocket'));
  assert.equal(c.decrypt(blob), 'shiprocket-password');
  assert.notEqual(c.encrypt('same'), c.encrypt('same'), 'fresh IV each time');
  const bad = blob.slice(0, -4) + 'AAAA';
  assert.throws(() => c.decrypt(bad));
  assert.equal(c.mask('abcdef1234'), '••••1234');
});

test('sanitize: strips $operators and dotted keys', () => {
  const { clean } = require(U + 'sanitize');
  assert.deepEqual(clean({ email: { $ne: null }, ok: 1, 'a.b': 2, nested: { $where: 'x', fine: true }, list: [{ $gt: 1, y: 2 }, { $ne: 1 }] }), { ok: 1, nested: { fine: true }, list: [{ y: 2 }] }, 'operator-only values are dropped, not left as empty objects');
  assert.deepEqual(clean({ a: {}, b: [] }), { a: {}, b: [] }, 'genuinely empty values are untouched');
});

test('logger redacts secrets', () => {
  const { redact } = require(U + 'logger');
  const r = redact({ authorization: 'Bearer abc', otp: '123456', user: { password: 'p', name: 'n' }, razorpay_signature: 's' });
  assert.equal(r.authorization, '[redacted]'); assert.equal(r.otp, '[redacted]'); assert.equal(r.user.password, '[redacted]'); assert.equal(r.user.name, 'n'); assert.equal(r.razorpay_signature, '[redacted]');
});

test('payment provider: checkout + webhook signatures (timing-safe)', () => {
  const crypto = require('crypto'); const { razorpayProvider } = require(U + 'paymentProvider');
  const p = razorpayProvider({ keyId: 'k', keySecret: 'sec', webhookSecret: 'wh', client: {} });
  const sig = crypto.createHmac('sha256', 'sec').update('order_1|pay_1').digest('hex');
  assert.equal(p.verifyCheckoutSignature({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: sig }), true);
  assert.equal(p.verifyCheckoutSignature({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_2', razorpay_signature: sig }), false);
  assert.equal(p.verifyCheckoutSignature({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'short' }), false);
  assert.equal(p.verifyCheckoutSignature({}), false);
  const body = Buffer.from('{"event":"payment.captured"}');
  assert.equal(p.verifyWebhookSignature(body, crypto.createHmac('sha256', 'wh').update(body).digest('hex')), true);
  assert.equal(p.verifyWebhookSignature(body, 'nope'), false);
  assert.equal(razorpayProvider({ keyId: 'k', keySecret: 's', client: {} }).verifyWebhookSignature(body, 'x'), false, 'no webhook secret configured → always reject');
});

/* ---------------- order state machine ---------------- */
const S = require(U + 'orderStatus');
const online = (o = {}) => ({ orderStatus: 'Pending', paymentStatus: 'Pending', payment: { method: '' }, events: [], ...o });
const cod = (o = {}) => ({ orderStatus: 'Processing', paymentStatus: 'Pending', payment: { method: 'cod' }, events: [], ...o });

test('order transitions: payment gate, forward-only, cancel/refund rules', () => {
  assert.equal(S.canTransition(online(), 'Processing').ok, false, 'cannot fulfil an unpaid online order');
  assert.equal(S.canTransition(online(), 'Paid').ok, true);
  assert.equal(S.canTransition(online({ orderStatus: 'Paid', paymentStatus: 'Paid' }), 'Packed').ok, true);
  assert.equal(S.canTransition(online({ orderStatus: 'Packed', paymentStatus: 'Paid' }), 'Processing').ok, false, 'no moving backwards');
  assert.equal(S.canTransition(cod(), 'Dispatched').ok, true, 'COD can be fulfilled without prior payment');
  assert.equal(S.canTransition(cod({ orderStatus: 'Delivered' }), 'Cancelled').ok, false);
  assert.equal(S.canTransition(online({ orderStatus: 'Pending' }), 'Cancelled').ok, true);
  assert.equal(S.canTransition(online({ orderStatus: 'Cancelled' }), 'Paid').ok, false, 'cancelled is terminal');
  assert.equal(S.canTransition(online({ orderStatus: 'Pending' }), 'Refunded').ok, false);
  assert.equal(S.canTransition(online({ orderStatus: 'Delivered', paymentStatus: 'Paid' }), 'Refunded').ok, true);
  assert.equal(S.canTransition(online(), 'Bogus').ok, false);
  assert.deepEqual(S.allowedNext(online({ orderStatus: 'Packed', paymentStatus: 'Paid' })), ['Dispatched', 'InTransit', 'OutForDelivery', 'Delivered', 'Cancelled', 'Refunded']);
});

test('journey: answers "where is my order" for every status', () => {
  const ev = (stage, at) => ({ stage, at, label: stage, public: true });
  let j = S.buildJourney(online({ orderStatus: 'Pending' }));
  assert.equal(j.stages[1].state, 'current'); assert.equal(j.stages[1].label, 'Awaiting payment'); assert.match(j.headline, /payment/i);
  j = S.buildJourney(online({ orderStatus: 'Packed', paymentStatus: 'Paid', events: [ev('placed', 1), ev('paid', 2)] }));
  assert.deepEqual(j.stages.map((s) => s.state), ['done', 'done', 'done', 'current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  assert.ok(j.stages[0].at && j.stages[1].at && !j.stages[3].at);
  j = S.buildJourney(online({ orderStatus: 'OutForDelivery', paymentStatus: 'Paid', shipment: { courierName: 'Delhivery', awb: 'AWB1', trackingUrl: 'http://t' }, events: [{ stage: 'transit', location: 'Chennai Hub', at: 5, label: 'x', public: true }] }));
  assert.equal(j.stages[6].state, 'current'); assert.equal(j.courier.awb, 'AWB1'); assert.equal(j.lastLocation.text, 'Chennai Hub'); assert.match(j.headline, /today/);
  j = S.buildJourney(online({ orderStatus: 'Delivered', paymentStatus: 'Paid' }));
  assert.ok(j.stages.every((s) => s.state === 'done')); assert.equal(j.progressPct, 100);
  j = S.buildJourney(cod({ events: [ev('placed', 1)] })); assert.match(j.stages[1].label, /pay on delivery/); assert.equal(j.cod, true);
  j = S.buildJourney(online({ orderStatus: 'Cancelled', paymentStatus: 'Paid', events: [ev('placed', 1), ev('paid', 2)] })); assert.match(j.headline, /cancelled/); assert.equal(j.stages[1].state, 'done');
  j = S.buildJourney(online({ orderStatus: 'Paid', paymentStatus: 'Paid', events: [{ stage: 'processing', label: 'internal', public: false, at: 1 }] })); assert.equal(j.events.length, 0, 'internal events never reach the customer');
});

/* ---------------- returns ---------------- */
const R = require(U + 'returnStatus');
test('return workflow: allowed paths only', () => {
  assert.equal(R.canTransition('REQUESTED', 'APPROVED').ok, true);
  assert.equal(R.canTransition('REQUESTED', 'REFUNDED').ok, false, 'cannot refund before review');
  assert.equal(R.canTransition('Requested', 'APPROVED').ok, true, 'legacy value accepted');
  assert.equal(R.canTransition('APPROVED', 'PICKUP_SCHEDULED').ok, true);
  assert.equal(R.canTransition('RECEIVED', 'REFUND_PENDING').ok, true);
  assert.equal(R.canTransition('REFUND_PENDING', 'REFUNDED').ok, true);
  assert.equal(R.canTransition('CLOSED', 'APPROVED').ok, false);
  assert.equal(R.canTransition('REFUNDED', 'APPROVED').ok, false);
  assert.deepEqual(R.allowedNext('INSPECTION'), ['REFUND_PENDING', 'CLOSED']);
});
test('return journey + eligibility + refundable amount', () => {
  assert.deepEqual(R.customerJourney({ status: 'PICKED_UP' }).steps.map((s) => s.state), ['done', 'done', 'current', 'upcoming', 'upcoming']);
  assert.ok(R.customerJourney({ status: 'REFUNDED' }).steps.every((s) => s.state === 'done'));
  assert.equal(R.customerJourney({ status: 'REJECTED' }).rejected, true);
  const order = { items: [{ name: 'A', sku: 'a', price: 2000, qty: 2 }, { name: 'B', sku: 'b', price: 1000, qty: 1 }], subtotal: 5000, total: 4500, shipping: 0, codFee: 0, refundedAmount: 0 };
  const el = R.eligibleQuantities(order, [{ status: 'APPROVED', items: [{ index: 0, qty: 1 }] }, { status: 'REJECTED', items: [{ index: 1, qty: 1 }] }]);
  assert.deepEqual(el.map((e) => e.eligible), [1, 1], 'rejected returns do not use up quantity');
  assert.equal(R.refundableAmount(order, [{ price: 2000, qty: 1 }]), 1800, 'share of the discounted total');
  assert.equal(R.refundableAmount(order, order.items.map((i) => ({ price: i.price, qty: i.qty }))), 4500, 'full return = full amount paid');
  assert.equal(R.refundableAmount({ ...order, codFee: 50, total: 4550 }, order.items.map((i) => ({ price: i.price, qty: i.qty }))), 4500, 'COD fee is not refunded');
  assert.equal(R.refundableAmount({ ...order, refundedAmount: 4000 }, [{ price: 2000, qty: 2 }]), 500, 'capped at what is left');
});

test('password strength rules', () => {
  const { checkPasswordStrength: c } = require('../src/utils/password');
  assert.match(c('short1'), /12/); assert.match(c('onlylettersnonumbers'), /letters and numbers/); assert.match(c('Correct horse battery 2026'), /^$/);
  assert.match(c('owner12345678x', 'owner@shop.test'), /email name/); assert.match(c('Password123456'), /easy to guess/); assert.equal(c('x'.repeat(200) + '1'), 'The password is too long (max 128 characters).'.replace('The password','That password'));
});
