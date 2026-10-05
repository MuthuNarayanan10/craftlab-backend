/** POST-DEPLOY SMOKE TEST — run against a deployed API (staging first!) to prove the critical path works.
 *    API=https://craftlab-backend-xxxx.onrender.com ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/smoke-test.js
 *  It places ONE real Cash-on-Delivery test order (needs COD enabled), checks stock moved, tracking works, then cancels it
 *  (which restores the stock). Nothing is charged. Exit code 1 = something is wrong. */
const API = (process.env.API || 'http://localhost:4000').replace(/\/$/, '') + '/api';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
let failed = 0;
const ok = (name, cond, info = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`); if (!cond) failed++; };
const j = async (path, opts = {}) => { const r = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); let body = {}; try { body = await r.json(); } catch (e) {} return { status: r.status, body }; };

(async () => {
  const h = await j('/health'); ok('API healthy + database connected', h.status === 200 && h.body.database === 'connected', JSON.stringify(h.body));
  const cfg = await j('/config/public'); ok('public config served', cfg.status === 200 && 'auth' in cfg.body);
  const prods = await j('/products'); ok('products listed', prods.status === 200 && prods.body.length > 0, `${prods.body.length} products`);
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) { console.log('\n(set ADMIN_EMAIL and ADMIN_PASSWORD to also test the order flow)'); return; }
  const login = await j('/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }); ok('admin login', login.status === 200 && login.body.token);
  const A = { Authorization: `Bearer ${login.body.token}` };
  ok('anonymous cannot read admin data', (await j('/admin/orders')).status === 401);
  const overview = await j('/admin/dashboard/overview', { headers: A }); ok('dashboard overview', overview.status === 200 && overview.body.readiness);
  const health = await j('/admin/system/health', { headers: A }); ok('system health', health.status === 200, JSON.stringify(health.body.problems));

  if (!cfg.body.codEnabled) { console.log('\nCOD is off — enable it in Admin → Business settings to run the order test.'); return; }
  const product = prods.body.find((p) => p.available > 0); if (!product) { ok('a product in stock to test with', false); return; }
  const cart = await j('/cart', { method: 'POST' }); await j(`/cart/${cart.body.cartId}/items`, { method: 'POST', body: { productId: product.id, qty: 1 } });
  const body = { cartId: cart.body.cartId, paymentMethod: 'cod', idempotencyKey: 'smoke-' + Date.now(), customer: { name: 'Smoke Test', phone: '9876543210', email: 'smoke@example.com' }, address: { line1: '1 Test Street', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' } };
  const o1 = await j('/checkout', { method: 'POST', body }); ok('COD order placed', o1.status === 201 && o1.body.orderNumber, o1.body.orderNumber || o1.body.error);
  if (o1.status !== 201) return;
  const o2 = await j('/checkout', { method: 'POST', body }); ok('double-submit returns the SAME order (idempotent)', o2.body.orderNumber === o1.body.orderNumber && o2.body.duplicate === true);
  const after = (await j('/products')).body.find((p) => p.id === product.id); ok('stock reduced by exactly 1', after.stock === product.stock - 1, `${product.stock} → ${after.stock}`);
  const tr = await j(`/track?orderNumber=${o1.body.orderNumber}&email=smoke@example.com`); ok('tracking works with order # + email', tr.status === 200 && tr.body.journey?.stages?.length === 8, tr.body.journey?.headline);
  ok('tracking refuses a wrong email', (await j(`/track?orderNumber=${o1.body.orderNumber}&email=wrong@example.com`)).status === 404);
  const cancel = await j(`/admin/orders/${o1.body.orderId}/cancel`, { method: 'POST', headers: A, body: { reason: 'smoke test' } }); ok('test order cancelled', cancel.status === 200);
  const restored = (await j('/products')).body.find((p) => p.id === product.id); ok('stock restored after cancellation', restored.stock === product.stock, `${restored.stock}`);
})().then(() => { console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nAll checks passed'); process.exit(failed ? 1 : 0); }).catch((e) => { console.error('Smoke test crashed:', e.message); process.exit(1); });
