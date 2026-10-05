/** Test database harness. Works with a real MongoDB (set TEST_MONGO_URI) or FerretDB (set FERRET=1), which lacks a few Mongo features
 *  ($expr comparisons, partial/TTL indexes). For FerretDB ONLY, this shim emulates the atomic $expr guards with compare-and-swap so the
 *  application code under test is unchanged. Production uses real MongoDB, where none of this is needed. */
const mongoose = require('mongoose');
const FERRET = process.env.FERRET === '1';

const get = (doc, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
function evalExpr(e, doc) {
  if (typeof e === 'string' && e.startsWith('$')) return get(doc, e.slice(1));
  if (e && typeof e === 'object') {
    if ('$subtract' in e) return evalExpr(e.$subtract[0], doc) - evalExpr(e.$subtract[1], doc);
    for (const [op, f] of [['$gte', (a, b) => a >= b], ['$lte', (a, b) => a <= b], ['$gt', (a, b) => a > b], ['$lt', (a, b) => a < b]]) if (op in e) return f(evalExpr(e[op][0], doc), evalExpr(e[op][1], doc));
  }
  return e;
}
const fieldsIn = (e, acc = new Set()) => { if (typeof e === 'string' && e.startsWith('$')) acc.add(e.slice(1)); else if (Array.isArray(e)) e.forEach((x) => fieldsIn(x, acc)); else if (e && typeof e === 'object') Object.values(e).forEach((x) => fieldsIn(x, acc)); return acc; };
function matchPlain(doc, cond) {
  return Object.entries(cond).every(([k, v]) => {
    const d = get(doc, k);
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !('_bsontype' in v)) return Object.entries(v).every(([op, x]) => ({ $lt: d < x, $gt: d > x, $lte: d <= x, $gte: d >= x, $ne: d !== x }[op]));
    return v === null ? d == null : String(d) === String(v);
  });
}
function parseFilter(filter) {
  const plain = {}; let pred = () => true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$expr') { const old = pred; pred = (d) => old(d) && !!evalExpr(v, d); }
    else if (k === '$or' && v.some((b) => b.$expr)) { const old = pred; pred = (d) => old(d) && v.some((b) => (b.$expr ? !!evalExpr(b.$expr, d) : matchPlain(d, b))); }
    else plain[k] = v;
  }
  return { plain, pred, fields: [...fieldsIn(filter)] };
}
const hasExpr = (f) => f && (f.$expr || (Array.isArray(f.$or) && f.$or.some((b) => b.$expr)));

// FerretDB's SQLite backend does not make read-modify-write updates atomic under parallel load (real MongoDB does).
// Serialising atomic-style updates here lets the application's logic be tested; real parallel atomicity needs real MongoDB.
let chain = Promise.resolve();
const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

function installShim() {
  const M = mongoose.Model;
  const rawFOAU = M.findOneAndUpdate, origCount = M.countDocuments;
  const origFOAU = function (...a) { return serial(() => rawFOAU.apply(this, a)); };
  M.findOneAndUpdate = async function (filter, update, opts) {
    if (!hasExpr(filter)) return origFOAU.call(this, filter, update, opts);
    const { plain, pred, fields } = parseFilter(filter);
    const self = this;
    return serial(async () => {
      const doc = await self.findOne(plain).lean();
      if (!doc || !pred(doc)) return null;
      const cas = { ...plain, _id: doc._id }; for (const f of fields) if (doc[f] !== undefined) cas[f] = doc[f];
      return rawFOAU.call(self, cas, update, opts);
    });
  };
  M.countDocuments = async function (filter, ...rest) {
    if (!hasExpr(filter)) return origCount.call(this, filter, ...rest);
    const { plain, pred } = parseFilter(filter);
    return (await this.find(plain).lean()).filter(pred).length;
  };
}

async function start() {
  process.env.NODE_ENV = 'test';
  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27018/craftlab_test', { serverSelectionTimeoutMS: 4000 });
  await mongoose.connection.dropDatabase();
  const models = require('fs').readdirSync(__dirname + '/../../src/models').map((f) => require('../../src/models/' + f));
  if (FERRET) {
    installShim();
    // the unique constraints the flows depend on (FerretDB can't do partial / sparse / TTL indexes)
    const uniq = async (m, spec) => m.collection.createIndex(spec, { unique: true });
    await uniq(require('../../src/models/Order'), { orderNumber: 1 });
    await uniq(require('../../src/models/Settings'), { key: 1 });
    await uniq(require('../../src/models/WebhookEvent'), { provider: 1, eventId: 1 });
    await uniq(require('../../src/models/NotificationLog'), { key: 1 });
    await uniq(require('../../src/models/Coupon'), { code: 1 });
    await uniq(require('../../src/models/Product'), { sku: 1 });
  } else { for (const m of models) if (m.init) await m.init(); }
}
async function stop() { await mongoose.disconnect(); }
module.exports = { start, stop, FERRET };
