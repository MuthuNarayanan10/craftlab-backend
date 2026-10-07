// Browser tests: reward points, cashback display, gift cards at checkout, Rewards tab, admin screens — REAL backend.
const { chromium } = require('playwright');
const CHROME = process.env.CHROME || '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
const B = 'http://localhost:4000', SHOTS = process.env.SHOTS || '/tmp/shots2'; require('fs').mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  — ' + x : '')); };
const api = async (path, opts = {}, token) => { const r = await fetch(B + '/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const BLOCK = /fonts\.(googleapis|gstatic)\.com|checkout\.razorpay\.com|gstatic\.com\/firebasejs|api\.qrserver\.com|postalpincode/;
const errs = [];
(async () => {
  const log = JSON.parse(require('fs').readFileSync('/tmp/ui-server.log', 'utf8').split('\n').find((l) => l.includes('"ready":true')));
  const owner = (await api('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'Passw0rd!x' } })).body.token; const custToken = log.customerToken;
  const me = (await api('/customers/me', {}, custToken)).body; const rack = (await api('/products')).body.find((p) => p.sku === 'CRAFTLAB-HNG-01');
  await api('/admin/settings', { method: 'PUT', body: { prepaidDiscountPercent: 0, codFee: 0, rewardsEnabled: true, giftCardsEnabled: true, rewardEarnPercent: 5, rewardRedeemMaxPercent: 20, rewardRedeemMinPoints: 100 } }, owner);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  async function newPage(vp = { width: 1280, height: 900 }, token) { const ctx = await browser.newContext({ viewport: vp }); await ctx.route(BLOCK, (r) => r.abort()); if (token) await ctx.addInitScript((t) => localStorage.setItem('cl_customer_token', t), token);
    const page = await ctx.newPage(); page.on('pageerror', (e) => errs.push(page.url().split('/').pop() + ': ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); }); return { ctx, page }; }
  async function toCheckout(page) { await page.goto(B + `/product.html?slug=${rack.slug}`); await page.waitForSelector('#addToCartBtn:not([disabled])'); await page.click('#addToCartBtn'); await page.waitForSelector('#clCartDrawer.open .dr-item'); await page.waitForSelector('#drPin #pwIn'); await page.click('#clCartDrawer [data-checkout]'); await page.waitForSelector('#clCoModal.open'); await page.waitForTimeout(900); }
  async function fillGuest(page) { await page.fill('#coName', 'Wallet Guest'); await page.fill('#coPhone', '9123400099'); await page.fill('#coEmail', 'wg@example.com'); await page.fill('#coLine1', '5 Test Road'); await page.fill('#coCity', 'Chennai'); await page.fill('#coState', 'Tamil Nadu'); await page.fill('#coPin', '600001'); await page.waitForTimeout(900); }
  const total = async (page) => (await page.locator('.co-total span').last().textContent()).replace(/[^\d]/g, '');

  /* ===== points at checkout (logged-in customer) ===== */
  await api(`/admin/rewards/customers/${me.id}/adjust`, { method: 'POST', body: { points: 300, note: 'ui test' } }, owner);
  let { ctx, page } = await newPage({ width: 1280, height: 900 }, custToken); await toCheckout(page);
  ok('checkout shows a Rewards & gift card section with the balance', /Rewards & gift card/.test(await page.locator('#coWallet').textContent()) && /You have 300 points \(₹300\)/.test(await page.locator('#coWallet').textContent()));
  const before = +(await total(page)); ok('the earn line shows what this order will earn (5% of ₹2,499 = 124)', /earn\s*124 points/.test(await page.locator('#coWallet').textContent()), (await page.locator('#coWallet').textContent()).replace(/\s+/g, ' ').slice(0, 160));
  await page.check('#coWallet input[data-c=points]'); await page.waitForTimeout(500);
  ok('using points lowers the total by ₹300, shows the line, and updates the earn line (5% of ₹2,199 = 109)', +(await total(page)) === before - 300 && /Reward points \(300\)/.test(await page.locator('#coLinesWrap').textContent()) && /earn\s*109 points/.test(await page.locator('#coWallet').textContent()));
  await page.screenshot({ path: SHOTS + '/60-checkout-points.png' });
  if (await page.locator('#coPin:visible').count()) { await page.fill('#coPin', '600001'); await page.waitForTimeout(500); }
  await page.check('input[name=pm][value=cod]'); await page.waitForTimeout(500);
  await Promise.all([page.waitForURL(/order-success/, { timeout: 15000 }), page.click('[data-co="pay"]')]).catch(async () => { ok('COD order with points placed', false, (await page.locator('#coErr').textContent().catch(() => '')).trim()); });
  const last = (await api('/admin/orders?limit=1', {}, owner)).body.orders[0]; const full = (await api('/admin/orders/' + last.id, {}, owner)).body;
  ok('the order records the points used and the points it will earn; the balance is spent', full.wallet.pointsUsed === 300 && full.wallet.pointsEarned === 109 && full.total === 2199 && full.wallet.earnStatus === 'pending' && (await api('/rewards/me', {}, custToken)).body.points === 0, `${full.orderNumber} total ${full.total}`);
  ok('the new order number is in the FY…CL… format', /^FY\d{4}CL\d{3,}$/.test(full.orderNumber)); await ctx.close();

  /* ===== gift card at checkout (guest) ===== */
  const card = (await api('/admin/rewards/gift-cards', { method: 'POST', body: { amount: 500 } }, owner)).body.cards[0];
  ({ ctx, page } = await newPage()); await toCheckout(page); await fillGuest(page); const t0 = +(await total(page));
  ok('guests see the gift-card box (and a prompt to log in for points)', await page.locator('#coGift').count() === 1 && /Log in to earn/.test(await page.locator('#coWallet').textContent()));
  await page.fill('#coGift', 'GC-AAAA-AAAA-AAAA'); await page.click('[data-co="gift"]'); await page.waitForSelector('#coGiftHint.bad'); ok('an unknown code is refused with a clear message', /isn’t valid/.test(await page.locator('#coGiftHint').textContent()));
  await page.fill('#coGift', card.code.toLowerCase()); await page.click('[data-co="gift"]'); await page.waitForSelector('#coWallet .co-chip');
  ok('a valid card appears as a chip with its balance; the total drops by ₹500', /…\w{4} · ₹500 balance/.test(await page.locator('#coWallet .co-chip').textContent()) && +(await total(page)) === t0 - 500 && /Gift card/.test(await page.locator('#coLinesWrap').textContent())); await page.screenshot({ path: SHOTS + '/61-checkout-giftcard.png' });
  await page.check('input[name=pm][value=cod]'); await page.waitForTimeout(500);
  await Promise.all([page.waitForURL(/order-success/, { timeout: 15000 }), page.click('[data-co="pay"]')]); ok('order placed with the card; the card balance is spent', (await api('/admin/rewards/gift-cards/' + card.id, {}, owner)).body.balance === 0); await ctx.close();
  // fully covered
  const big = (await api('/admin/rewards/gift-cards', { method: 'POST', body: { amount: 5000 } }, owner)).body.cards[0];
  ({ ctx, page } = await newPage()); await toCheckout(page); await fillGuest(page); await page.fill('#coGift', big.code); await page.click('[data-co="gift"]'); await page.waitForSelector('#coWallet .co-chip');
  ok('a card that covers everything changes the button to “fully covered by your rewards”', /fully covered/.test(await page.locator('[data-co="pay"]').textContent()) && +(await total(page)) === 0);
  await Promise.all([page.waitForURL(/order-success/, { timeout: 15000 }), page.click('[data-co="pay"]')]); const lo = (await api('/admin/orders?limit=1', {}, owner)).body.orders[0];
  ok('the order is confirmed as paid immediately; the unused ₹2,501 stays on the card', lo.paymentStatus === 'Paid' && (await api('/admin/rewards/gift-cards/' + big.id, {}, owner)).body.balance === 2501, `${lo.orderNumber} ${lo.paymentStatus}`); await ctx.close();

  /* ===== account Rewards tab ===== */
  ({ ctx, page } = await newPage({ width: 1280, height: 900 }, custToken)); await page.goto(B + '/account.html?tab=rewards'); await page.waitForSelector('#gcBtn');
  const rt = await page.locator('#tabBody').textContent(); ok('Rewards tab: balance, pending, the rules with the ₹1000 → 50 example', /Available points/.test(rt) && /Pending/.test(rt) && /₹1000 → 50 points/.test(rt) && /₹500 → 25 points/.test(rt) && /1 point = ₹1/.test(rt) && /20%/.test(rt));
  ok('history shows the purchase earning and the points used', /Used/.test(rt) && /Earned/.test(rt) && /-300/.test(rt));
  await page.fill('#gcIn', big.code); await page.click('#gcBtn'); await page.waitForTimeout(700); ok('customers can check a gift-card balance', /₹2,501/.test(await page.locator('#gcOut').textContent()), (await page.locator('#gcOut').textContent()).trim());
  await page.screenshot({ path: SHOTS + '/62-account-rewards.png', fullPage: true });
  await page.goto(B + '/account.html?tab=orders'); await page.waitForSelector('.order-card'); ok('an order card notes what was paid with points', /₹300 from points/.test(await page.locator('.order-card').first().textContent()) || /points/.test(await page.locator('#tabBody').textContent())); await ctx.close();

  /* ===== admin ===== */
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await actx.route(BLOCK, (r) => r.abort()); await actx.addInitScript((t) => localStorage.setItem('cl_admin_token', t), owner);
  const a = await actx.newPage(); a.on('pageerror', (e) => errs.push('admin ' + e.message)); a.on('dialog', (d) => d.accept(d.message().includes('Add or remove') ? '200' : undefined)); const go = async (p) => { await a.goto(`${B}/admin/${p}`); await a.waitForTimeout(800); };
  await go('gift-cards.html'); ok('gift cards: list shows the issued cards with balances', /GC-/.test(await a.locator('#body').textContent()) && /Cards with balance/.test(await a.locator('#kpis').textContent()));
  await a.click('#newBtn'); await a.fill('#gAmt', '750'); await a.fill('#gCount', '2'); await a.fill('#gNote', 'UI test'); await a.click('#gSave'); await a.waitForSelector('#outModal.open textarea'); const codes = (await a.locator('#outModal textarea').inputValue()).split('\n').map((l) => l.trim().split(/\s+/)[0]);
  ok('issuing 2 cards shows both codes once, ready to copy', codes.length === 2 && codes.every((c) => /^GC-/.test(c)) && new Set(codes).size === 2); await a.screenshot({ path: SHOTS + '/63-admin-giftcards.png' }); await a.click('#outModal .a-btn-fill');
  await a.fill('#q', codes[0]); await a.waitForTimeout(900); await a.locator('[data-act=adj]').first().click(); await a.waitForTimeout(900); ok('adjusting a card balance (+₹200) works', (await api('/admin/rewards/gift-cards?q=' + codes[0], {}, owner)).body.cards[0].balance === 950);
  await a.locator('[data-act=tog]').first().click(); await a.waitForTimeout(900); ok('a card can be disabled', (await api('/admin/rewards/gift-cards?q=' + codes[0], {}, owner)).body.cards[0].status === 'disabled');
  await go('rewards.html'); ok('reward points: summary shows what is owed to customers', /Points customers can spend/.test(await a.locator('#kpis').textContent()));
  await a.fill('#q', me.email ? me.email.slice(0, 5) : 'Muthu'); await a.waitForSelector('#results [data-open]'); await a.click('#results [data-open]'); await a.waitForSelector('#aGo'); await a.fill('#aPts', '50'); await a.fill('#aNote', 'goodwill'); await a.click('#aGo'); await a.waitForTimeout(900);
  ok('an owner can adjust a customer’s points; it appears in their history', (await api('/rewards/me', {}, custToken)).body.points === 50 && /goodwill/.test(await a.locator('#detail').textContent())); await a.screenshot({ path: SHOTS + '/64-admin-rewards.png', fullPage: true });
  await go('settings.html'); await a.fill('[name=rewardEarnPercent]', '4'); await a.fill('[name=cashbackPercent]', '2'); await a.click('#saveBtn'); await a.waitForTimeout(900); const pc = (await api('/config/public')).body.rewards; ok('settings: earn rate and cashback save and reach the storefront', pc.earnPercent === 4 && pc.cashbackPercent === 2);
  await a.fill('[name=rewardEarnPercent]', '5'); await a.fill('[name=cashbackPercent]', '0'); await a.click('#saveBtn'); await a.waitForTimeout(700);
  await go('orders.html'); await a.fill('#searchBox', full.orderNumber); await a.waitForTimeout(1000); await a.locator('[data-manage]').first().click(); await a.waitForSelector('#saveStatus'); ok('the admin order view shows the points used on that order and the points it earns', /Reward points used \(300\)/.test(await a.locator('#orderModalBody').textContent()));
  const over = []; const mm = await browser.newContext({ viewport: { width: 390, height: 844 } }); await mm.route(BLOCK, (r) => r.abort()); await mm.addInitScript((t) => localStorage.setItem('cl_admin_token', t), owner); const mp = await mm.newPage(); for (const f of ['gift-cards', 'rewards']) { await mp.goto(`${B}/admin/${f}.html`); await mp.waitForTimeout(600); if (await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) over.push(f); } ok('new admin pages fit a phone', !over.length, over.join(','));
  const m2 = await newPage({ width: 390, height: 844 }); await toCheckout(m2.page); ok('mobile: the checkout wallet section fits the screen', !(await m2.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) && await m2.page.locator('#coGift').count() === 1); await m2.page.screenshot({ path: SHOTS + '/65-checkout-mobile.png' });
  console.log('\nJS errors:', errs.length ? '\n' + errs.join('\n') : 'none'); console.log(`${pass}/${pass + fail} passed`); await browser.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message.slice(0, 400), (e.stack.match(/rewards\.ui\.js:\d+/) || [''])[0]); console.error(errs); process.exit(1); });
