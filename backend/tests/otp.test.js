const test = require('node:test'); const assert = require('node:assert/strict');
const { createOtpService, normalizePhone, OtpError } = require('../src/utils/otpService');
const { devSender, msg91Sender } = require('../src/utils/otp/senders');

function memStore() {
  const rows = []; let n = 0;
  return {
    rows,
    latest: async (phone) => rows.filter((r) => r.phone === phone).sort((a, b) => b.createdAt - a.createdAt)[0] || null,
    latestActive: async (phone) => rows.filter((r) => r.phone === phone && !r.consumed).sort((a, b) => b.createdAt - a.createdAt)[0] || null,
    countRecent: async ({ phone, ip, since }) => rows.filter((r) => (phone ? r.phone === phone : r.ip === ip) && r.createdAt >= since).length,
    create: async (d) => { const r = { id: ++n, consumed: false, ...d }; rows.push(r); return r; },
    incrementAttempts: async (id) => ++rows.find((r) => r.id === id).attempts,
    consume: async (id) => { rows.find((r) => r.id === id).consumed = true; },
    invalidate: async (phone) => { rows.filter((r) => r.phone === phone).forEach((r) => (r.consumed = true)); },
  };
}
function make(opts = {}) {
  let t = 1_000_000; const store = memStore(); const sent = [];
  const sender = opts.sender || { id: 'dev', send: async (p, c) => sent.push({ p, c }) };
  const svc = createOtpService({ store, sender, hmacSecret: 'h', now: () => t, isProduction: !!opts.prod, config: opts.config });
  return { svc, store, sent, advance: (ms) => { t += ms; } };
}

test('phone normalisation', () => {
  for (const x of ['9876543210', '09876543210', '919876543210', '+91 98765 43210', '98765-43210']) assert.equal(normalizePhone(x), '+919876543210');
  for (const x of ['1234567890', '98765', '', null, '5876543210', 'abcdefghij']) assert.equal(normalizePhone(x), null);
});

test('happy path: send → verify → single use', async () => {
  const { svc, sent, store } = make();
  const r = await svc.send('9876543210', '1.1.1.1');
  assert.equal(r.phone, '+919876543210'); assert.match(sent[0].c, /^\d{6}$/); assert.equal(r.devCode, sent[0].c);
  assert.ok(!JSON.stringify(store.rows).includes(sent[0].c), 'code is never stored in plain text');
  assert.deepEqual(await svc.verify('9876543210', sent[0].c), { phone: '+919876543210' });
  await assert.rejects(svc.verify('9876543210', sent[0].c), (e) => e.code === 'NO_OTP', 'a code cannot be reused');
});
test('dev code is never returned in production', async () => {
  const { svc } = make({ prod: true }); assert.equal((await svc.send('9876543210')).devCode, undefined);
});
test('wrong code: attempts counted, then locked even for the right code', async () => {
  const { svc, sent } = make();
  await svc.send('9876543210');
  for (let i = 0; i < 5; i++) await assert.rejects(svc.verify('9876543210', '000000' === sent[0].c ? '111111' : '000000'), (e) => e.code === 'INVALID');
  await assert.rejects(svc.verify('9876543210', sent[0].c), (e) => e.code === 'LOCKED');
});
test('expiry', async () => {
  const { svc, sent, advance } = make(); await svc.send('9876543210'); advance(5 * 60e3 + 1);
  await assert.rejects(svc.verify('9876543210', sent[0].c), (e) => e.code === 'EXPIRED');
});
test('resend cool-down, then new code invalidates the old one', async () => {
  const { svc, sent, advance } = make(); await svc.send('9876543210');
  await assert.rejects(svc.send('9876543210'), (e) => e.code === 'COOLDOWN' && e.status === 429 && e.retryAfterSec > 0);
  advance(31e3); await svc.send('9876543210');
  await assert.rejects(svc.verify('9876543210', sent[0].c), (e) => ['INVALID', 'NO_OTP'].includes(e.code), 'first code no longer works');
  assert.ok((await svc.verify('9876543210', sent[1].c)).phone);
});
test('hourly caps per phone and per IP', async () => {
  const a = make({ config: { resendCooldownMs: 0 } });
  for (let i = 0; i < 5; i++) await a.svc.send('9876543210', '9.9.9.9');
  await assert.rejects(a.svc.send('9876543210', '9.9.9.9'), (e) => e.code === 'TOO_MANY_PHONE');
  const b = make({ config: { resendCooldownMs: 0, maxSendsPerIpHour: 3 } });
  for (let i = 0; i < 3; i++) await b.svc.send(`98765432${10 + i}`, '2.2.2.2');
  await assert.rejects(b.svc.send('9876543299', '2.2.2.2'), (e) => e.code === 'TOO_MANY_IP');
  await b.svc.send('9876543299', '3.3.3.3'); // a different IP is unaffected
});
test('invalid phone / bad code format / provider failure', async () => {
  const { svc } = make(); await assert.rejects(svc.send('12345'), (e) => e.code === 'INVALID_PHONE');
  await assert.rejects(svc.verify('9876543210', 'abc'), (e) => e.code === 'INVALID_INPUT');
  const f = make({ sender: { id: 'x', send: async () => { throw new Error('provider down'); } } });
  await assert.rejects(f.svc.send('9876543210'), (e) => e.code === 'SEND_FAILED' && e.status === 502);
  assert.ok(f.store.rows.every((r) => r.consumed), 'a code that was never delivered is unusable');
  assert.equal(await f.store.latestActive('+919876543210'), null);
});
test('senders: dev refused in production; MSG91 request shape + error handling', async () => {
  await assert.rejects(devSender({ isProduction: true, allow: false }).send('+919876543210', '123456'), /disabled in production/);
  const calls = [];
  const ok = msg91Sender({ authKey: 'K', templateId: 'T', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ type: 'success' }) }; } });
  await ok.send('+919876543210', '654321');
  assert.match(calls[0].url, /template_id=T&mobile=919876543210&authkey=K&otp=654321/); assert.equal(calls[0].init.method, 'POST');
  const bad = msg91Sender({ authKey: 'K', templateId: 'T', fetchImpl: async () => ({ ok: true, json: async () => ({ type: 'error', message: 'DLT template mismatch' }) }) });
  await assert.rejects(bad.send('+919876543210', '1'), /DLT template mismatch/);
  assert.throws(() => msg91Sender({}), /auth key/);
});
