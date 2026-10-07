/** Mobile-OTP service (provider-agnostic).
 *  - 6-digit codes from a CSPRNG, stored only as an HMAC (never in plain text), single-use, 5-minute expiry
 *  - resend cool-down, per-phone and per-IP hourly caps, max wrong attempts per code
 *  - the SMS provider is a plug-in `sender` ({ id, send(phone, code) }) — swap providers without touching this logic */
const crypto = require('crypto');

class OtpError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); }
}

/** Accepts 9876543210, 09876543210, 919876543210, +91 98765 43210 → "+919876543210". Indian mobile numbers only. */
function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? '+91' + d : null;
}

/** Lower-cases and validates an email address. */
function normalizeEmail(input) {
  const e = String(input || '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

function createOtpService({ store, sender, hmacSecret, channel = 'phone', now = () => Date.now(), config = {}, isProduction = process.env.NODE_ENV === 'production' }) {
  if (!hmacSecret) throw new Error('OTP service needs an HMAC secret');
  const cfg = { ttlMs: 5 * 60e3, resendCooldownMs: 30e3, maxSendsPerPhoneHour: 5, maxSendsPerIpHour: 20, maxAttempts: 5, length: 6, ...config };
  const norm = channel === 'email' ? normalizeEmail : normalizePhone;
  const what = channel === 'email' ? 'email address' : 'mobile number';
  const hash = (phone, code) => crypto.createHmac('sha256', hmacSecret).update(`${phone}:${code}`).digest('hex');

  async function send(rawPhone, ip) {
    const phone = norm(rawPhone);
    if (!phone) throw new OtpError(channel === 'email' ? 'INVALID_EMAIL' : 'INVALID_PHONE', channel === 'email' ? 'Please enter a valid email address' : 'Please enter a valid 10-digit mobile number');
    const t = now();

    const latest = await store.latest(phone);
    if (latest && t - new Date(latest.createdAt).getTime() < cfg.resendCooldownMs) {
      const retryAfterSec = Math.ceil((cfg.resendCooldownMs - (t - new Date(latest.createdAt).getTime())) / 1000);
      throw new OtpError('COOLDOWN', `Please wait ${retryAfterSec}s before requesting another code`, 429, { retryAfterSec });
    }
    const since = new Date(t - 3600e3);
    if ((await store.countRecent({ phone, since })) >= cfg.maxSendsPerPhoneHour) throw new OtpError('TOO_MANY_PHONE', `Too many codes requested for this ${what}. Please try again in an hour.`, 429);
    if (ip && (await store.countRecent({ ip, since })) >= cfg.maxSendsPerIpHour) throw new OtpError('TOO_MANY_IP', 'Too many requests from this network. Please try again later.', 429);

    const code = String(crypto.randomInt(0, 10 ** cfg.length)).padStart(cfg.length, '0');
    await store.invalidate(phone); // earlier codes stop working the moment a new one is issued
    const rec = await store.create({ phone, codeHash: hash(phone, code), expiresAt: new Date(t + cfg.ttlMs), attempts: 0, ip: ip || '', createdAt: new Date(t) });
    try { await sender.send(phone, code); }
    catch (e) { await store.consume(rec.id); throw new OtpError('SEND_FAILED', 'We couldn’t send the OTP right now. Please try again shortly.', 502, { cause: e.message }); }

    return { phone, identifier: phone, expiresInSec: Math.round(cfg.ttlMs / 1000), resendAfterSec: Math.round(cfg.resendCooldownMs / 1000), devCode: sender.id === 'dev' && !isProduction ? code : undefined };
  }

  async function verify(rawPhone, rawCode) {
    const phone = norm(rawPhone);
    const code = String(rawCode || '').trim();
    if (!phone || !/^\d{4,8}$/.test(code)) throw new OtpError('INVALID_INPUT', 'Enter the code we sent you');
    const rec = await store.latestActive(phone);
    if (!rec) throw new OtpError('NO_OTP', 'That code has expired or was already used. Please request a new one.');
    if (new Date(rec.expiresAt).getTime() < now()) throw new OtpError('EXPIRED', 'That code has expired. Please request a new one.');
    if (rec.attempts >= cfg.maxAttempts) throw new OtpError('LOCKED', 'Too many wrong attempts. Please request a new code.', 429);

    const attempts = await store.incrementAttempts(rec.id);
    const a = Buffer.from(hash(phone, code)), b = Buffer.from(rec.codeHash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      const left = Math.max(0, cfg.maxAttempts - attempts);
      throw new OtpError('INVALID', left ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please request a new code.', 400, { attemptsLeft: left });
    }
    await store.consume(rec.id);
    return { phone };
  }
  return { send, verify, normalizePhone, normalizeEmail, config: cfg };
}

module.exports = { createOtpService, normalizePhone, normalizeEmail, OtpError };
