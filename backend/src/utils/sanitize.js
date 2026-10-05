/** NoSQL-injection guard: drops any key starting with "$" or containing "." from req.body / req.query / req.params,
 *  so {"email": {"$ne": null}} can never reach a MongoDB query as an operator.
 *  A value that was ONLY operators (an attack) is removed entirely — never left behind as a truthy empty object. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean).filter((v) => v !== undefined);
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Buffer)) {
    const out = {}; let removed = 0;
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.')) { removed++; continue; }
      const c = clean(v);
      if (c !== undefined) out[k] = c;
    }
    return removed > 0 && Object.keys(out).length === 0 ? undefined : out;
  }
  return value;
}
function sanitizeRequest(req, res, next) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body = clean(req.body) || {};
  if (req.query) { for (const k of Object.keys(req.query)) { const c = k.startsWith('$') || k.includes('.') ? undefined : clean(req.query[k]); if (c === undefined) delete req.query[k]; else req.query[k] = c; } }
  if (req.params) req.params = clean(req.params) || {};
  next();
}
module.exports = { sanitizeRequest, clean };
