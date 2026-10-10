// Browser tests: admin Categories page, product form (category + optional sub-category), Customers guest filter, grouped shop page — REAL backend.
const { chromium } = require('playwright');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const B = 'http://localhost:4000', SHOTS = process.env.SHOTS || '/tmp/shots3'; require('fs').mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  — ' + x : '')); };
const api = async (path, opts = {}, token) => { const r = await fetch(B + '/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const BLOCK = /fonts\.(googleapis|gstatic)\.com|api\.qrserver\.com|checkout\.razorpay\.com|gstatic\.com\/firebasejs|postalpincode/;
(async () => {
  const owner = (await api('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'Passw0rd!x' } })).body.token;
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] }); const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await ctx.route(BLOCK, (r) => r.abort());
  const page = await ctx.newPage(); page.on('pageerror', (e) => errs.push(page.url().split('/').pop() + ': ' + e.message));
  page.on('dialog', (d) => d.accept());
  const until = async (fn, tries = 30) => { for (let i = 0; i < tries; i++) { try { if (await fn()) return true; } catch (e) {} await page.waitForTimeout(250); } return false; };
  await page.goto(`${B}/admin/login.html`); await page.fill('input[type=email]', 'owner@shop.test'); await page.fill('input[type=password]', 'Passw0rd!x'); await Promise.all([page.waitForURL(/admin\/(index\.html)?$/), page.click('button[type=submit]')]);

  /* ---- Categories page ---- */
  await page.goto(`${B}/admin/categories.html`); await page.waitForSelector('[data-f=cname]');
  ok('categories page lists the category already used by products', (await page.locator('[data-f=cname]').first().inputValue()) === 'Wall Organizers');
  ok('sidebar has a Categories entry', await page.locator('.admin-nav a', { hasText: 'Categories' }).count() > 0);
  await page.click('[data-act=addsub]'); await page.locator('[data-f=sname]').first().fill('Hook Racks');
  await page.click('#addCat'); await page.locator('[data-f=cname]').last().fill('Planters');
  await page.click('#saveAll'); ok('saving works', await until(async () => (await api('/admin/categories', {}, owner)).body.categories.some((c) => c.name === 'Planters')));
  await page.screenshot({ path: SHOTS + '/60-admin-categories.png', fullPage: true });

  /* ---- Product form ---- */
  await page.goto(`${B}/admin/products.html`); await page.waitForSelector('#tableBody tr'); await page.waitForTimeout(500);
  ok('products table has a Category column', /Category/.test(await page.locator('thead').textContent()));
  await page.click('#addBtn'); await page.waitForSelector('#fCategory option', { state: 'attached' });
  ok('category is a dropdown with the managed categories', (await page.locator('#fCategory option').allTextContents()).includes('Planters'));
  await page.selectOption('#fCategory', 'Planters'); ok('sub-category hidden when the category has none', !(await page.locator('#subWrap').isVisible()));
  await page.selectOption('#fCategory', 'Wall Organizers'); ok('sub-category appears (optional) for a category that has some', await page.locator('#subWrap').isVisible() && (await page.locator('#fSub').inputValue()) === '');
  await page.fill('#fName', 'Browser Hook Rack'); await page.fill('#fSku', 'BR-1'); await page.fill('#fSlug', 'browser-hook-rack'); await page.fill('#fPrice', '999'); await page.fill('#fMrp', '1200'); await page.fill('#fStock', '4');
  await page.selectOption('#fSub', 'Hook Racks'); await page.click('#productForm button[type=submit]');
  ok('product saved with category + sub-category', await until(async () => { const p = (await api('/products/browser-hook-rack')).body; return p.category === 'Wall Organizers' && p.subcategory === 'Hook Racks'; }));
  await page.click('#addBtn'); await page.selectOption('#fCategory', 'Planters'); ok('Planters has no sub-categories, so none is shown', !(await page.locator('#subWrap').isVisible()));
  await page.fill('#fName', 'Browser Planter'); await page.fill('#fSku', 'BR-2'); await page.fill('#fSlug', 'browser-planter'); await page.fill('#fPrice', '500'); await page.fill('#fMrp', '600'); await page.fill('#fStock', '2');
  await page.click('#productForm button[type=submit]');
  ok('product without sub-category saved with none', await until(async () => { const p = (await api('/products/browser-planter')).body; return p.category === 'Planters' && p.subcategory === ''; }));

  /* ---- Storefront shop page ---- */
  const sp = await ctx.newPage(); sp.on('pageerror', (e) => errs.push('shop: ' + e.message));
  await sp.goto(`${B}/shop.html`); await sp.waitForSelector('.cat-block');
  ok('shop (All) shows a headed section per category', await sp.locator('.cat-block .cat-head h2').count() === 2);
  ok('sub-category heading shown only where products have one', await sp.locator('.sub-head', { hasText: 'Hook Racks' }).count() === 1 && await sp.locator('.cat-block', { hasText: 'Planters' }).locator('.sub-head').count() === 0);
  await sp.screenshot({ path: SHOTS + '/61-shop-grouped.png', fullPage: true });
  await sp.click('#catChips a[data-c="Wall Organizers"]'); await sp.waitForSelector('#subChips:not([hidden])');
  ok('choosing a category shows only it + sub-category chips', await sp.locator('.product-card').count() === 3 && await sp.locator('#subChips a').count() === 2);
  await sp.click('#subChips a[data-s="Hook Racks"]'); await sp.waitForTimeout(300);
  ok('choosing a sub-category narrows to it and updates the URL', await sp.locator('.product-card').count() === 1 && /subcategory=Hook/.test(sp.url()));
  await sp.goto(`${B}/shop.html?category=Planters`); await sp.waitForSelector('.product-card');
  ok('direct category link works; no sub-chips for a category without them', await sp.locator('.product-card').count() === 1 && await sp.locator('#subChips').isHidden());
  await sp.goto(`${B}/product.html?slug=browser-hook-rack`); await sp.waitForSelector('.eyebrow');
  ok('product page shows category › sub-category', /Wall Organizers › Hook Racks/.test(await sp.locator('.pdp-info .eyebrow').textContent()));
  const sm = await ctx.newPage(); await sm.setViewportSize({ width: 390, height: 800 }); await sm.goto(`${B}/shop.html`); await sm.waitForSelector('.cat-block');
  ok('mobile: no horizontal scroll', await sm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await sm.screenshot({ path: SHOTS + '/62-shop-mobile.png' });

  /* ---- Customers: guests ---- */
  const cartId = (await api('/cart', { method: 'POST' })).body.cartId; const prod = (await api('/products')).body[0];
  await api(`/cart/${cartId}/items`, { method: 'POST', body: { productId: prod.id, qty: 1 } });
  const co = await api('/checkout', { method: 'POST', body: { cartId, paymentMethod: 'cod', customer: { name: 'Gita Guest', phone: '9811122233', email: 'gita@example.com' }, address: { line1: '1 Road', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' } } });
  ok('guest COD order placed', co.status === 201, JSON.stringify(co.body).slice(0, 120));
  await page.goto(`${B}/admin/customers.html`); await page.waitForSelector('#tableBody tr'); await page.selectOption('#ctype', 'guest');
  ok('Guests filter shows the guest with a Guest badge', await until(async () => /Gita Guest/.test(await page.locator('#tableBody').textContent()) && /Guest/.test(await page.locator('#tableBody .badge.gray').first().textContent())));
  await page.selectOption('#ctype', 'registered'); ok('Registered filter hides the guest', await until(async () => !/Gita Guest/.test(await page.locator('#tableBody').textContent())));
  await page.screenshot({ path: SHOTS + '/63-admin-customers.png' });

  /* ---- Integrations: email OTP status card ---- */
  await page.goto(`${B}/admin/integrations.html`); await page.waitForSelector('#otpEnv .method-card');
  ok('Integrations shows the Brevo email-login card (NOT SET without env vars) and no old Brevo form', /NOT SET/.test(await page.locator('#otpEnv').textContent()) && /BREVO_API_KEY/.test(await page.locator('#otpEnv').textContent()) && !/Brevo \(email OTP/.test(await page.locator('#list').textContent()));
  await page.screenshot({ path: SHOTS + '/64-admin-integrations.png' });

  console.log(`\n${pass} passed, ${fail} failed`); if (errs.length) console.log('PAGE ERRORS:', errs); await browser.close(); process.exit(fail || errs.length ? 1 : 0);
})();
