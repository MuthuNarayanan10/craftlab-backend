/** SIMULTANEOUS-ORDERS TEST — proves the store can't oversell when several customers buy the last units at once.
 *  !! Run ONLY against STAGING. It temporarily sets a product's stock, places test Cash-on-Delivery orders, then cancels them and restores the stock.
 *    API=https://your-staging-api CONFIRM=yes-this-is-staging ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run race
 *  Optional: STOCK=3 BUYERS=8   (default 3 units, 8 simultaneous buyers). Exit code 1 = it oversold or left stock wrong. */
const API = (process.env.API || '').replace(/\/$/, '') + '/api';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (process.env.CONFIRM !== 'yes-this-is-staging' || !process.env.API || !ADMIN_EMAIL || !ADMIN_PASSWORD) { console.error('Set API, ADMIN_EMAIL, ADMIN_PASSWORD and CONFIRM=yes-this-is-staging (this changes stock — never run it on your live store).'); process.exit(2); }
const STOCK = +process.env.STOCK || 3, BUYERS = +process.env.BUYERS || 8;
const j = async (path, opts = {}) => { const r = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
(async () => {
  const login = await j('/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }); if (login.status !== 200) throw new Error('Admin login failed');
  const A = { Authorization: 'Bearer ' + login.body.token };
  const cfg = (await j('/config/public')).body; if (!cfg.codEnabled) throw new Error('Switch Cash on Delivery on (Admin → Settings) for this test.');
  const prods = (await j('/products')).body; const p = prods[0]; if (!p) throw new Error('No product found');
  const original = p.stock; console.log(`Product: ${p.name} — original stock ${original}. Setting stock to ${STOCK}, then ${BUYERS} buyers race for it…`);
  await j('/admin/products/' + p.id, { method: 'PUT', headers: A, body: { stock: STOCK } });
  const carts = await Promise.all(Array.from({ length: BUYERS }, async () => { const c = (await j('/cart', { method: 'POST' })).body.cartId; await j(`/cart/${c}/items`, { method: 'POST', body: { productId: p.id, qty: 1 } }); return c; }));
  const t0 = Date.now();
  const results = await Promise.all(carts.map((cartId, i) => j('/checkout', { method: 'POST', body: { cartId, paymentMethod: 'cod', idempotencyKey: `race-${Date.now()}-${i}-xxxx`, customer: { name: 'Race Test', phone: '9876543210', email: 'race@example.com' }, address: { line1: '1 Test St', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' } } })));
  const won = results.filter((r) => r.status === 201), lost = results.filter((r) => r.status === 409);
  console.log(`${BUYERS} simultaneous checkouts in ${Date.now() - t0} ms → ${won.length} succeeded, ${lost.length} told "not enough stock", ${results.length - won.length - lost.length} other`);
  const after = (await j('/products')).body.find((x) => x.id === p.id);
  const bad = [];
  if (won.length !== Math.min(STOCK, BUYERS)) bad.push(`expected exactly ${Math.min(STOCK, BUYERS)} orders, got ${won.length}`);
  if (after.stock !== STOCK - won.length) bad.push(`stock should be ${STOCK - won.length}, is ${after.stock}`);
  for (const w of won) await j(`/admin/orders/${w.body.orderId}/cancel`, { method: 'POST', headers: A, body: { reason: 'race test' } });
  await j('/admin/products/' + p.id, { method: 'PUT', headers: A, body: { stock: original } });
  const end = (await j('/products')).body.find((x) => x.id === p.id); if (end.stock !== original) bad.push(`stock not restored (${end.stock} vs ${original}) — fix it in Admin → Inventory`);
  console.log(bad.length ? 'FAIL: ' + bad.join('; ') : `PASS — never oversold; stock restored to ${original}.`); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('Race test crashed:', e.message); process.exit(1); });
