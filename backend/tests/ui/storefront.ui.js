// Browser tests for the storefront, driven against the REAL backend (tests/support/ui-server.js).  Requires: playwright + Chrome.
//   FERRET=1 node tests/support/ui-server.js &   then   node tests/ui/storefront.ui.js
const { chromium } = require('playwright');
const CHROME = process.env.CHROME || '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
const B = 'http://localhost:4000', SHOTS = process.env.SHOTS || '/tmp/shots2';
require('fs').mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  — ' + x : '')); };
const api = async (path, opts = {}, token) => { const r = await fetch(B + '/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const BLOCK = /fonts\.(googleapis|gstatic)\.com|gstatic\.com\/firebasejs|api\.qrserver\.com|postalpincode/;
const FAKE_RZP = `window.Razorpay = class { constructor(o){ this.o = o; } on(){} open(){ const pid = 'pay_ui_' + Date.now(); fetch('/__sign?o=' + this.o.order_id + '&p=' + pid).then(r => r.json()).then(s => this.o.handler({ razorpay_order_id: this.o.order_id, razorpay_payment_id: pid, razorpay_signature: s.sig })); } };`;

(async () => {
  const owner = (await api('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'Passw0rd!x' } })).body.token;
  const setSettings = (b) => api('/admin/settings', { method: 'PUT', body: b }, owner);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const errs = [];
  async function newPage(vp = { width: 1280, height: 900 }) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: vp.width < 500 ? 2 : 1, permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.route(BLOCK, (r) => r.abort()); await ctx.route('**/checkout.razorpay.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_RZP }));
    const page = await ctx.newPage(); page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); });
    return { ctx, page };
  }
  const addToCart = async (page, slug) => { await page.goto(`${B}/product.html?slug=${slug}`); await page.waitForSelector('#addToCartBtn'); await page.click('#addToCartBtn'); await page.waitForSelector('#clCartDrawer.open .dr-item'); };
  const openCheckout = async (page) => { await page.click('#clCartDrawer [data-checkout]'); await page.waitForSelector('#clCoModal.open'); await page.waitForTimeout(500); };
  const fillGuest = async (page, pin = '603110') => { await page.fill('#coName', 'Test Guest'); await page.fill('#coPhone', '9123456789'); await page.fill('#coEmail', 'guest@example.com'); await page.fill('#coPin', pin); await page.fill('#coCity', 'Chennai'); await page.fill('#coState', 'Tamil Nadu'); await page.fill('#coLine1', '1 Test Street'); await page.waitForTimeout(700); };
  const lastOrder = async () => (await api('/admin/orders?limit=1', {}, owner)).body.orders[0];

  /* ============ 1. delivery options in checkout ============ */
  let { ctx, page } = await newPage();
  await addToCart(page, 'sculptural-wall-hook-rack'); await openCheckout(page);
  ok('before a PIN is typed, options are shown with a note that availability is confirmed from the PIN', /confirmed once you enter your PIN/.test(await page.locator('#coDelivery').textContent()));
  await fillGuest(page, '603110');
  let names = await page.locator('#coDelivery .dm-card strong').allTextContents();
  ok('options appear for a PIN outside the local area: Standard + Express (not Local delivery)', names.join('|') === 'Standard delivery|Express delivery', names.join('|'));
  ok('Standard is pre-selected and free', await page.locator('#coDelivery .dm-card.sel strong').textContent() === 'Standard delivery' && /Free/.test(await page.locator('#coDelivery .dm-card.sel').textContent()));
  await page.screenshot({ path: SHOTS + '/01-checkout-delivery.png' });
  await page.click('#coDelivery .dm-card:has-text("Express")'); await page.waitForTimeout(300);
  const onlineTotal = await page.locator('.co-sum strong').textContent();
  ok('choosing Express adds ₹149 on top of the prepaid-discounted goods', onlineTotal === '₹2,523', onlineTotal);   // 2499 - 5% (125) + 149
  ok('summary shows the delivery line with the method name', /Delivery · Express delivery[\s\S]*₹149/.test(await page.locator('#coLinesWrap').textContent()));
  await page.check('input[name=pm][value=cod]'); await page.waitForTimeout(700);
  ok('Express is greyed out for Cash on Delivery and the selection falls back to Standard', await page.locator('#coDelivery .dm-card.dis').count() === 1 && /Not available with Cash on Delivery/.test(await page.locator('#coDelivery .dm-card.dis').textContent()) && await page.locator('#coDelivery .dm-card.sel strong').textContent() === 'Standard delivery');
  await Promise.all([page.waitForURL(/order-success/), page.click('[data-co="pay"]')]);
  let o = await lastOrder(); ok('COD order placed with Standard delivery', o.delivery.method === 'Standard delivery' && o.payment.method === 'cod', o.orderNumber);
  await ctx.close();

  /* ============ 2. manual (local) delivery appears only in its area ============ */
  ({ ctx, page } = await newPage());
  await addToCart(page, 'classic-row-wall-hook-rack'); await openCheckout(page); await fillGuest(page, '600002');
  names = await page.locator('#coDelivery .dm-card strong').allTextContents();
  ok('local delivery appears for a Chennai PIN (600xxx)', names.includes('Local delivery by our team'), names.join('|'));
  await page.click('#coDelivery .dm-card:has-text("Local delivery")'); await page.waitForTimeout(300); await page.check('input[name=pm][value=cod]'); await page.waitForTimeout(600);
  ok('manual delivery allows COD and costs ₹40', await page.locator('#coDelivery .dm-card.sel strong').textContent() === 'Local delivery by our team' && /₹40/.test(await page.locator('#coDelivery .dm-card.sel').textContent()) && await page.locator('.co-sum strong').textContent() === '₹2,539');
  await page.screenshot({ path: SHOTS + '/02-checkout-manual.png' });
  await Promise.all([page.waitForURL(/order-success/), page.click('[data-co="pay"]')]);
  o = await lastOrder(); ok('order saved with the manual delivery method + fee', o.delivery.type === 'manual' && o.total === 2539, `${o.delivery.method} ₹${o.total}`);
  ok('success page shows the order number', /CL-\d+/.test(await page.locator('#orderDetails').textContent()));
  await ctx.close();

  /* ============ 3. online payment (Razorpay faked in the browser) ============ */
  ({ ctx, page } = await newPage());
  await addToCart(page, 'sculptural-wall-hook-rack'); await openCheckout(page); await fillGuest(page, '603110');
  await Promise.all([page.waitForURL(/order-success/, { timeout: 20000 }), page.click('[data-co="pay"]')]);
  await page.waitForTimeout(500); o = await lastOrder(); const det = (await api('/admin/orders/' + o.id, {}, owner)).body;
  ok('online payment confirmed on the server (signature verified) and order marked paid', o.paymentStatus === 'Paid' && det.payment.verifiedVia === 'checkout-callback', `${o.orderNumber} ${o.paymentStatus}`);
  ok('prepaid discount applied', det.prepaidDiscount === 125 && det.total === 2374, `₹${det.total}`);
  await ctx.close();

  /* ============ 4. login rules set by the admin are enforced in the UI ============ */
  await setSettings({ requireMobileVerification: true });
  ({ ctx, page } = await newPage());
  await addToCart(page, 'sculptural-wall-hook-rack'); await openCheckout(page);
  ok('mobile verification required → checkout shows ONLY the login step (no form to fill)', await page.locator('#coName').count() === 0 && /Verify your mobile number/.test(await page.locator('#clCoModal').textContent()));
  await page.screenshot({ path: SHOTS + '/03-checkout-login-gate.png' });
  await page.click('[data-co="otp"]'); await page.waitForSelector('#clOtpModal', { state: 'visible' });
  await page.fill('#clOtpPhoneInput', '98765'); await page.click('#clOtpSendBtn'); ok('a short number is rejected', /valid 10-digit/.test(await page.locator('#clOtpPhoneError').textContent()));
  await page.fill('#clOtpPhoneInput', '9988776655'); await page.click('#clOtpSendBtn'); await page.waitForSelector('#clOtpStepCode', { state: 'visible' });
  const hint = await page.locator('#clOtpDevHint').textContent(); const code = (hint.match(/\d{6}/) || [])[0]; ok('test mode shows the code on screen (never in production)', !!code, hint);
  ok('resend is on a cooldown', /Resend code in \d+s/.test(await page.locator('#clOtpResendBtn').textContent()));
  await page.screenshot({ path: SHOTS + '/04-otp-modal.png' });
  await page.fill('#clOtpCodeInput', code === '000000' ? '111111' : '000000'); await page.waitForSelector('#clOtpCodeError:not(:empty)'); ok('a wrong code is refused with attempts left', /Incorrect code\. \d attempts? left/.test(await page.locator('#clOtpCodeError').textContent()));
  await page.fill('#clOtpCodeInput', code); await page.waitForSelector('#coName', { timeout: 8000 });
  ok('after OTP the checkout opens, phone is locked to the verified number', (await page.inputValue('#coPhone')) === '9988776655' && await page.locator('#coPhone').getAttribute('readonly') !== null);
  await page.fill('#coName', 'Otp Buyer'); await page.fill('#coEmail', 'otp@example.com'); await page.fill('#coPin', '603110'); await page.fill('#coCity', 'Chennai'); await page.fill('#coState', 'Tamil Nadu'); await page.fill('#coLine1', '5 OTP Street'); await page.waitForTimeout(700);
  await page.check('input[name=pm][value=cod]'); await page.waitForTimeout(500);
  await Promise.all([page.waitForURL(/order-success/), page.click('[data-co="pay"]')]); o = await lastOrder();
  const acct = (await api('/admin/customers?q=9988776655', {}, owner)).body.customers[0]; ok('a verified customer account was created automatically and the order is linked to it', acct && acct.phoneVerified && o.customer.phone === '+919988776655', acct?.name);
  const saved = await page.evaluate(() => localStorage.getItem('cl_customer_token')); ok('the customer stays logged in', !!saved);
  await ctx.close();
  await setSettings({ requireMobileVerification: false, guestCheckoutEnabled: false });
  ({ ctx, page } = await newPage()); await addToCart(page, 'sculptural-wall-hook-rack'); await openCheckout(page);
  ok('guest checkout switched off → login required', await page.locator('#coName').count() === 0 && await page.locator('[data-co="otp"]').count() === 1); await ctx.close();
  await setSettings({ guestCheckoutEnabled: true, otpEnabled: false });
  ({ ctx, page } = await newPage()); await addToCart(page, 'sculptural-wall-hook-rack'); await openCheckout(page);
  ok('OTP switched off → no OTP button; guest form is shown', await page.locator('[data-co="otp"]').count() === 0 && await page.locator('#coName').count() === 1); await ctx.close();
  await setSettings({ otpEnabled: true });

  console.log('\nJS errors:', errs.length ? errs.join(' | ') : 'none'); console.log(`${pass}/${pass + fail} passed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
