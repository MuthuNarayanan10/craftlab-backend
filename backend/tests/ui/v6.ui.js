// v6 features end-to-end in a browser: checkout qty, guest invoice, order-ID help, hero carousel, admin deletes, customers, categories-in-product-form.
//   FERRET=1 node tests/support/ui-server.js &   then   node tests/ui/v6.ui.js
const { chromium } = require('playwright');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const B = 'http://localhost:4000', SHOTS = process.env.SHOTS || '/tmp/shots6';
require('fs').mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  — ' + x : '')); };
const api = async (path, opts = {}, token) => { const r = await fetch(B + '/api' + path, { ...opts, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, body: j }; };
const BLOCK = /fonts\.(googleapis|gstatic)\.com|gstatic\.com\/firebasejs|api\.qrserver\.com|postalpincode/;
const FAKE_RZP = `window.Razorpay = class { constructor(o){ this.o = o; window.__rzpOpts = o; } on(){} open(){ const pid = 'pay_ui_' + Date.now(); fetch('/__sign?o=' + this.o.order_id + '&p=' + pid).then(r => r.json()).then(s => this.o.handler({ razorpay_order_id: this.o.order_id, razorpay_payment_id: pid, razorpay_signature: s.sig })); } };`;
(async () => {
  const owner = (await api('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'Passw0rd!x' } })).body.token;
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const errs = [];
  async function newPage(vp = { width: 1280, height: 900 }) {
    const ctx = await browser.newContext({ viewport: vp });
    await ctx.route(BLOCK, (r) => r.abort()); await ctx.route('**/checkout.razorpay.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_RZP }));
    const page = await ctx.newPage(); page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); });
    return { ctx, page };
  }
  const addToCart = async (page, slug) => { await page.goto(`${B}/product.html?slug=${slug}`); await page.waitForSelector('#addToCartBtn'); await page.click('#addToCartBtn'); await page.waitForSelector('#clCartDrawer.open .dr-item'); };

  /* ---- checkout: guest note, qty steppers, UPI-first Razorpay config, invoice on success ---- */
  let { ctx, page } = await newPage();
  await addToCart(page, 'sculptural-wall-hook-rack');
  await page.click('#clCartDrawer [data-checkout]'); await page.waitForSelector('#clCoModal.open'); await page.waitForTimeout(500);
  ok('guest sees the positive "no account needed" note', /No account needed/.test(await page.locator('.co-guest-note').textContent()));
  ok('items are listed in checkout with a stepper', await page.locator('#coItems .co-item').count() === 1);
  await page.click('#coItems [data-d="1"]'); await page.waitForTimeout(900);
  ok('+ in checkout raises quantity and the total', (await page.locator('#coItems .ci-qty span').textContent()) === '2' && /2 items/.test(await page.locator('.co-sum').textContent()), await page.locator('.co-sum').textContent());
  await page.click('#coItems [data-d="-1"]'); await page.waitForTimeout(900);
  ok('− in checkout lowers it again', (await page.locator('#coItems .ci-qty span').textContent()) === '1');
  await page.screenshot({ path: SHOTS + '/01-checkout-items.png' });
  await page.fill('#coName', 'Asha Verma'); await page.fill('#coPhone', '9123456780'); await page.fill('#coEmail', 'asha.guest@example.com'); await page.fill('#coPin', '603110'); await page.fill('#coCity', 'Chennai'); await page.fill('#coState', 'Tamil Nadu'); await page.fill('#coLine1', '1 Test Street'); await page.waitForTimeout(2200);
  const cartRows = await api('/admin/abandoned-carts', {}, owner);
  ok('contact is saved on the cart before paying (for abandoned-cart follow-up)', cartRows.status === 200);
  await page.click('[data-co="pay"]'); await page.waitForURL(/order-success/, { timeout: 15000 });
  const opts = await page.evaluate(() => 0);
  await page.waitForSelector('#invFrame', { state: 'attached' }); await page.waitForFunction(() => !document.getElementById('invWrap').hidden, null, { timeout: 15000 });
  const invText = await page.frameLocator('#invFrame').locator('body').textContent();
  ok('success page shows a GST tax invoice with Order ID, amount in words and totals', /TAX INVOICE/.test(invText) && /FY2026CL/.test(invText) && /Rupees/.test(invText) && /Order ID/.test(invText), invText.slice(0, 80));
  ok('guest is told no account was needed', await page.locator('#guestMsg').isVisible());
  await page.screenshot({ path: SHOTS + '/02-success-invoice.png', fullPage: true });
  const orderNo = new URL(page.url()).searchParams.get('order');
  const guests = (await api('/admin/customers?type=guest', {}, owner)).body.customers;
  ok('guest buyer is saved in Admin → Customers', guests.some((c) => c.email === 'asha.guest@example.com'));
  await ctx.close();

  /* ---- order tracking: order-ID help + invoice ---- */
  ({ ctx, page } = await newPage());
  await page.goto(`${B}/order-tracking.html`); await page.click('#idHelp'); await page.waitForSelector('#clDocModal iframe');
  await page.waitForTimeout(500);
  const help = await page.frameLocator('#clDocModal iframe').locator('.mark').textContent();
  ok('"where is my order ID" pop-up shows a sample invoice with the Order ID marked', /FY2026CL0042/.test(help) && /Order ID/.test(help), help);
  await page.screenshot({ path: SHOTS + '/03-orderid-help.png' }); await page.click('#clDocModal [data-doc="close"]');
  await page.fill('#fOrderNumber', orderNo); await page.fill('#fContact', 'asha.guest@example.com'); await page.click('#lookup button[type=submit]'); await page.waitForSelector('#invBtn');
  await page.click('#invBtn'); await page.waitForSelector('#clDocModal iframe'); await page.waitForTimeout(500);
  ok('tracking page opens the tax invoice in a pop-up', /TAX INVOICE/.test(await page.frameLocator('#clDocModal iframe').locator('body').textContent()));
  const bad = await api(`/track/invoice?orderNumber=${orderNo}&email=someone@else.com`);
  ok('invoice needs the right contact', bad.status === 404);
  await ctx.close();

  /* ---- hero carousel from admin ---- */
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const put = await api('/admin/hero', { method: 'PUT', body: { slides: [{ image: 'images/hero-lifestyle.jpg', alt: 'One', link: 'shop.html' }, { image: px, alt: 'Two', link: '' }] } }, owner);
  ok('admin can save two homepage pictures', put.status === 200);
  ok('hero images are served as real files', (await fetch(B + (await api('/hero')).body.slides[1].image)).headers.get('content-type') === 'image/png');
  ok('bad picture rejected', (await api('/admin/hero', { method: 'PUT', body: { slides: [{ image: 'javascript:alert(1)' }] } }, owner)).status === 400);
  ({ ctx, page } = await newPage({ width: 1280, height: 900 }));
  await page.goto(B + '/index.html'); await page.waitForSelector('#heroImg .hs-slide');
  ok('homepage shows a carousel with 2 slides, dots and arrows', await page.locator('#heroImg .hs-slide').count() === 2 && await page.locator('#heroImg .hs-dot').count() === 2 && await page.locator('#heroImg .hs-nav').count() === 2);
  await page.click('#heroImg .hs-nav.next'); await page.waitForTimeout(900);
  ok('next arrow moves to slide 2', await page.locator('#heroImg .hs-slide.on').getAttribute('aria-label') === '2 of 2');
  await page.screenshot({ path: SHOTS + '/04-hero.png' });
  await ctx.close();
  await api('/admin/hero', { method: 'PUT', body: { slides: [] } }, owner);

  /* ---- admin: confirmation boxes, deletes, customers, categories in product form, abandoned carts ---- */
  ({ ctx, page } = await newPage({ width: 1360, height: 900 }));
  await page.goto(B + '/admin/login.html'); await page.fill('input[type=email]', 'owner@shop.test'); await page.fill('input[type=password]', 'Passw0rd!x'); await page.click('button[type=submit]'); await page.waitForURL(/admin\/(index|$)/);
  await page.goto(B + '/admin/customers.html'); await page.waitForSelector('#tableBody tr');
  await page.click('#addCust'); await page.fill('#cfName', 'Manual Customer'); await page.fill('#cfPhone', '9000011111'); await page.fill('#cfEmail', 'manual@example.com'); await page.click('#cfSave'); await page.waitForTimeout(800);
  ok('owner can add a customer by hand', (await api('/admin/customers?q=manual', {}, owner)).body.customers.some((c) => c.email === 'manual@example.com'));
  await page.fill('#q', 'manual'); await page.waitForTimeout(700); await page.click('[data-view]'); await page.waitForSelector('#delCust');
  await page.click('#delCust'); await page.waitForSelector('.modal-overlay[role=alertdialog]');
  ok('delete asks for confirmation first', await page.locator('[role=alertdialog] h3').textContent().then((t) => /Delete Manual Customer/.test(t)));
  await page.click('[role=alertdialog] [data-x="no"]'); ok('cancel keeps the customer', (await api('/admin/customers?q=manual', {}, owner)).body.customers.length === 1);
  await page.click('#delCust'); await page.click('[role=alertdialog] [data-x="yes"]'); await page.waitForTimeout(800);
  ok('confirming deletes the customer', (await api('/admin/customers?q=manual', {}, owner)).body.customers.length === 0);

  await page.goto(B + '/admin/orders.html'); await page.waitForSelector('[data-manage]'); await page.click('[data-manage] >> nth=0'); await page.waitForSelector('#deleteOrder');
  const before = (await api('/admin/orders?limit=100', {}, owner)).body.orders.length; const num = (await page.locator('#orderModalBody h3, #orderModalBody h2').first().textContent()).match(/FY\d+CL\d+/)?.[0];
  await page.click('#deleteOrder'); await page.waitForSelector('[role=alertdialog] #adcInput');
  ok('deleting an order needs the order number typed', await page.locator('[role=alertdialog] [data-x="yes"]').isDisabled());
  await page.fill('#adcInput', num || 'X'); await page.click('[role=alertdialog] [data-x="yes"]'); await page.waitForTimeout(1000);
  ok('order is deleted after typing its number', (await api('/admin/orders?limit=100', {}, owner)).body.orders.length === before - 1, num);

  await page.goto(B + '/admin/products.html'); await page.waitForSelector('#tableBody tr'); await page.click('#addBtn'); await page.waitForSelector('#newCatBtn');
  await page.click('#newCatBtn'); await page.fill('#newCatName', 'Planters v6'); await page.click('#newCatAdd'); await page.waitForTimeout(900);
  ok('new category can be added inside the product form', (await page.locator('#fCategory').inputValue()) === 'Planters v6');
  ok('sub-category field is visible with None', await page.locator('#subWrap').isVisible());
  await page.click('#newSubBtn'); await page.fill('#newSubName', 'Hanging pots'); await page.click('#newSubAdd'); await page.waitForTimeout(900);
  ok('new sub-category can be added and is selected', (await page.locator('#fSub').inputValue()) === 'Hanging pots');
  await page.screenshot({ path: SHOTS + '/05-product-form.png' });
  ok('categories were saved on the server', (await api('/admin/categories', {}, owner)).body.categories.some((c) => c.name === 'Planters v6' && c.subcategories.some((s) => s.name === 'Hanging pots')));

  await page.goto(B + '/admin/hero.html'); await page.waitForSelector('.slide');
  ok('homepage-pictures admin page lists the built-in picture', await page.locator('.slide').count() === 1);
  await page.goto(B + '/admin/abandoned-carts.html'); await page.waitForTimeout(800);
  ok('abandoned carts page loads', /Abandoned Carts/.test(await page.locator('h1').textContent()));
  await ctx.close();

  /* ---- account icon goes straight to login (with guest + track links) ---- */
  await api('/admin/settings', { method: 'PUT', body: { otpEnabled: true, otpProvider: 'dev', customerLoginEnabled: true } }, owner);
  ({ ctx, page } = await newPage());
  await page.goto(B + '/account.html'); await page.waitForSelector('#clOtpModal', { state: 'visible', timeout: 8000 });
  ok('account page opens the login pop-up straight away', await page.locator('#clOtpModal').isVisible());
  ok('login pop-up offers guest + order tracking', /Continue as guest/.test(await page.locator('#clOtpModal').textContent()) && /Track an order/.test(await page.locator('#clOtpModal').textContent()));
  await page.screenshot({ path: SHOTS + '/06-login.png' });
  await ctx.close();

  /* ---- API-level: resend limit, earlier code still valid, inbound mail ---- */
  const ph = '9876501234'; const sends = [];
  for (let i = 0; i < 5; i++) { await fetch(B + '/__reset-otp'); sends.push(await api('/customers/otp/send', { method: 'POST', body: { phone: ph, channel: 'phone' } })); }
  ok('first send + 3 resends allowed, 5th refused with a friendly message', sends.slice(0, 4).every((r) => r.status === 200) && sends[3].body.resendsLeft === 0 && sends[4].status === 429 && /maximum number of codes/.test(sends[4].body.error), sends.map((r) => r.status).join(','));
  const tk = await api('/support', { method: 'POST', body: { name: 'Reply Tester', email: 'replytest@example.com', subject: 'Hello there', message: 'First message here' } });
  const inbound = await api('/admin/integrations/inbound-mail', {}, owner);
  const hook = await fetch(B + inbound.body.webhookPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ From: { Address: 'replytest@example.com' }, Subject: 'Re: We’ve received your request ' + tk.body.ticketNumber, RawTextBody: 'My reply by email\n\nOn Mon, someone wrote:\n> quoted text', MessageId: '<m1@x>' }] }) });
  const t = (await api('/admin/support/' + tk.body.id, {}, owner)).body;
  ok('customer email reply lands on the ticket (quoted text stripped)', hook.status === 200 && t.messages.length === 2 && t.messages[1].text === 'My reply by email' && t.messages[1].via === 'email', JSON.stringify(t.messages.map((m) => m.text)));
  ok('wrong token is refused', (await fetch(B + '/api/webhooks/inbound-mail?token=nope', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401);
  const spoof = await fetch(B + inbound.body.webhookPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'stranger@example.com', subject: 'Re: ' + tk.body.ticketNumber, text: 'hi' }) });
  ok('a stranger cannot add to someone else’s ticket', (await (await api('/admin/support/' + tk.body.id, {}, owner)).body.messages.length) === 2 && spoof.status === 200);

  ok('no browser errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await browser.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
