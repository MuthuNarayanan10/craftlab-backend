/** Structured (JSON) logging with request ids, so one request can be traced across logs.
 *  Sensitive fields are always redacted. */
const crypto = require('crypto');
const SENSITIVE = /pass(word)?|secret|token|authorization|api[-_]?key|otp|code|signature|cvv|card/i;

function redact(obj, depth = 0) {
  if (obj == null || depth > 4) return obj;
  if (Array.isArray(obj)) return obj.map((x) => redact(x, depth + 1));
  if (typeof obj === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(obj)) o[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
    return o;
  }
  return obj;
}
function write(level, event, fields) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...redact(fields || {}) });
  (level === 'error' ? console.error : console.log)(line);
}
const logger = {
  info: (e, f) => write('info', e, f), warn: (e, f) => write('warn', e, f), error: (e, f) => write('error', e, f),
  redact,
};

function requestLogger(req, res, next) {
  req.id = req.header('x-request-id') || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/api/health') return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    write(level, 'http', { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms), ip: req.ip });
  });
  next();
}
module.exports = { logger, requestLogger, redact };
