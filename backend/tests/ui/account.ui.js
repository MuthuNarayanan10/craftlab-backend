// Browser tests: order tracking, customer account, returns, invoices — against the REAL backend (tests/support/ui-server.js).
const { chromium } = require('playwright');
const CHROME = process.env.CHROME || '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
const B = 'http://localhost:4000', SHOTS = process.env.SHOTS || '/tmp/shots2'; const PHOTO = process.env.PHOTO || '/tmp/mock/damage.jpg';
require('fs').mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  — ' + x : '')); };
const api = async (path, opts = {}, token) => { const r = await fetch(B + '/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const BLOCK = /fonts\.(googleapis|gstatic)\.com|gstatic\.com\/firebasejs|api\.qrserver\.com|postalpincode/;

(async () => {
  await fetch(B + '/__reset-otp');
  const owner = (await api('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'Passw0rd!x' } })).body.token;
  const orders = (await api('/admin/orders?limit=20', {}, owner)).body.orders; const num = (re) => orders.find(re).orderNumber;
  const manualOut = orders.find((o) => o.delivery.type === 'manual' && o.orderStatus === 'OutForDelivery'), inTransit = orders.find((o) => o.orderStatus === 'InTransit'), delivered = orders.find((o) => o.orderStatus === 'Delivered' && o.items[0].qty === 2), packed = orders.find((o) => o.orderStatus === 'Packed');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] }); const errs = [];
  async function newPage(vp = { width: 1280, height: 900 }) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: vp.width < 500 ? 2 : 1, permissions: ['clipboard-read', 'clipboard-write'] }); await ctx.route(BLOCK, (r) => r.abort());
    const page = await ctx.newPage(); page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); }); return { ctx, page };
  }
  const track = async (page, o, contact) => { await page.goto(`${B}/order-tracking.html?order=${o.orderNumber}`); await page.fill('#fContact', contact); await page.click('#lookup button'); await page.waitForSelector('.trk-hero', { timeout: 8000 }); await page.waitForTimeout(1500); };

  /* ================= TRACKING ================= */
  let { ctx, page } = await newPage();
  await page.goto(`${B}/order-tracking.html`); await page.fill('#fOrderNumber', manualOut.orderNumber); await page.fill('#fContact', 'wrong@example.com'); await page.click('#lookup button'); await page.waitForSelector('#trackError:not(:empty)');
  ok('wrong email reveals nothing', /No order found/.test(await page.locator('#trackError').textContent()));
  await track(page, manualOut, '9876543210');   // by mobile number
  ok('MANUAL delivery: headline answers "where is my order"', /Out for delivery today/.test(await page.locator('.trk-hero h2').textContent()));
  const states = await page.locator('.step').evaluateAll((els) => els.map((e) => e.className.replace('step ', '')));
  ok('stepper: 8 stages, first 6 done, "out for delivery" current, last upcoming', states.length === 8 && states.slice(0, 6).every((s) => s === 'done') && states[6] === 'current' && states[7] === 'upcoming', states.join(','));
  const w = await page.locator('#bar').evaluate((e) => parseFloat(e.style.width)); ok('progress bar animates to the right place', w >= 85 && w <= 97, w + '%');
  ok('own-team delivery card: names the person, offers a call button, shows no courier/AWB', /Delivered by our own team/.test(await page.locator('.trk-partner').textContent()) && /Rajan/.test(await page.locator('.trk-partner').textContent()) && (await page.locator('a[href="tel:9000000009"]').count() === 1 || await page.locator('a[href^="tel:"]').count() === 1) && !/AWB|Delhivery/.test(await page.locator('.trk-card').nth(1).textContent()));
  ok('chips: delivery method + Cash on Delivery amount', /Local delivery by our team/.test(await page.locator('.trk-chips').textContent()) && /Pay on delivery/.test(await page.locator('.trk-chips').textContent()));
  ok('timeline lists updates newest first', await page.locator('.tl li').count() >= 5 && /Out for delivery/.test(await page.locator('.tl li').first().textContent()));
  await page.screenshot({ path: SHOTS + '/10-track-manual.png', fullPage: true });
  await track(page, inTransit, 'muthu@example.com');
  ok('COURIER: shows partner + tracking number, hides the person card', /Delhivery/.test(await page.locator('.trk-partner').textContent()) && /DL778899/.test(await page.locator('.trk-awb').textContent()) && !/delivery person/i.test(await page.locator('.trk-partner').textContent()));
  ok('in-transit headline', /on its way/i.test(await page.locator('.trk-hero h2').textContent())); await page.click('#copyAwb'); ok('tracking number can be copied', (await page.evaluate(() => navigator.clipboard.readText())) === 'DL778899');
  await page.screenshot({ path: SHOTS + '/11-track-courier.png', fullPage: true });
  await track(page, delivered, 'muthu@example.com'); ok('delivered: every stage done, 100%', (await page.locator('.step.done').count()) === 8 && /Delivered/.test(await page.locator('.trk-hero h2').textContent()) && (await page.locator('#bar').evaluate((e) => parseFloat(e.style.width))) === 100);
  ok('delivered orders offer the return path', await page.locator('a:has-text("Return or report a problem")').count() === 1); await ctx.close();
  ({ ctx, page } = await newPage({ width: 390, height: 844 })); await track(page, manualOut, 'muthu@example.com');
  ok('mobile: tracking page fits the screen (no sideways scroll)', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
  ok('mobile: stepper is a vertical list', await page.locator('.step').first().evaluate((e) => getComputedStyle(e).display) === 'grid');
  await page.screenshot({ path: SHOTS + '/12-track-mobile.png', fullPage: true }); await ctx.close();

  /* ================= ACCOUNT ================= */
  ({ ctx, page } = await newPage());
  await page.goto(`${B}/account.html`); await page.waitForSelector('#otpLoginBtn'); await page.screenshot({ path: SHOTS + '/13-account-login.png' });
  ok('logged-out page offers OTP first, then email login + sign-up', await page.locator('#loginForm').count() === 1 && await page.locator('#signupForm').count() === 1);
  await page.click('#otpLoginBtn'); await page.fill('#clOtpPhoneInput', '9876543210'); await page.check('#clOtpTerms'); await page.click('#clOtpSendBtn'); await page.waitForSelector('#clOtpStepCode', { state: 'visible' });
  const code = ((await page.locator('#clOtpDevHint').textContent()).match(/\d{6}/) || [])[0]; await page.fill('#clOtpCodeInput', code); await page.waitForSelector('[data-tab=orders]', { timeout: 8000 }); ok('login lands on My Details with account information', /Account information/.test(await page.locator('#tabBody').textContent()) && /Terms accepted/.test(await page.locator('#tabBody').textContent())); await page.click('[data-tab=orders]'); await page.waitForSelector('.order-card', { timeout: 8000 });
  ok('OTP login recognises the existing customer and shows their orders', await page.locator('.order-card').count() >= 4 && /Hello, Muthu/.test(await page.locator('.page-banner h1').textContent()));
  const card = page.locator('.order-card', { hasText: manualOut.orderNumber });
  ok('order card: mini journey, status pill, delivery method, track button', await card.locator('.mini-j').count() === 1 && /Out for delivery/.test(await card.textContent()) && /Local delivery by our team/.test(await card.textContent()) && await card.locator('a:has-text("Track order")').count() === 1);
  await page.screenshot({ path: SHOTS + '/14-account-orders.png', fullPage: true });
  // invoice
  await page.evaluate(() => { window.__printed = null; const orig = HTMLIFrameElement.prototype; const add = document.body.appendChild.bind(document.body); document.body.appendChild = function (n) { const r = add(n); if (n.tagName === 'IFRAME') setTimeout(() => { try { n.contentWindow.print = () => { window.__printed = n.contentDocument.body.innerHTML; }; } catch (e) {} }, 0); return r; }; });
  const dCard = page.locator('.order-card', { hasText: delivered.orderNumber }); await dCard.locator('[data-invoice]').click(); await page.waitForFunction(() => window.__printed, null, { timeout: 8000 });
  const inv = await page.evaluate(() => window.__printed); ok('customer can print a GST invoice (business GSTIN, CGST+SGST for same-state, delivery line)', /TAX INVOICE/.test(inv) && /33ABCDE1234F1Z5/.test(inv) && /CGST @ 9%/.test(inv) && /SGST @ 9%/.test(inv) && /Delivery \(Standard delivery\)/.test(inv) && /INV-\d+/.test(inv));
  // return flow
  await dCard.locator('[data-return]').click(); await page.waitForSelector('#rtModal.open'); await page.waitForTimeout(300);
  ok('return modal: items with quantity picker, reasons, window deadline', await page.locator('#rtLines [data-line]').count() === 1 && await page.locator('#rtLines select option').count() === 2 && (await page.locator('#rtReason option').count()) === 7 && /until/.test(await page.locator('#rtWindow').textContent()));
  await page.screenshot({ path: SHOTS + '/15-return-modal.png' });
  await page.selectOption('#rtLines select', '1'); await page.selectOption('#rtReason', 'Damaged on arrival'); await page.fill('#rtComments', 'One peg is cracked'); await page.setInputFiles('#rtFile', PHOTO); await page.waitForSelector('#rtPhotos .photo-thumb'); await page.click('#rtSubmit');
  await page.waitForSelector('#rtModal:not(.open)', { timeout: 8000 }); await page.waitForTimeout(800);
  const after = page.locator('.order-card', { hasText: delivered.orderNumber });
  ok('after submitting, the order shows its return journey (Requested)', /Return · Return requested/.test(await after.textContent()) && await after.locator('[data-return]').count() === 0, '₹2,499 for 1 of 2 units');
  const rets = (await api('/admin/returns', {}, owner)).body.returns; const r1 = rets.find((r) => r.orderNumber === delivered.orderNumber); ok('server recorded 1 unit, refundable ₹2,499, photo attached', r1 && r1.items[0].qty === 1 && r1.amount === 2499 && r1.imageCount === 1 && r1.reason === 'Damaged on arrival');
  for (const st of ['APPROVED']) await api(`/admin/returns/${r1.id}/status`, { method: 'PUT', body: { status: st } }, owner);
  await page.reload(); await page.waitForSelector('[data-tab=orders]'); await page.click('[data-tab=orders]'); await page.waitForSelector('.order-card'); ok('journey follows the admin’s decision (Approved)', /Return · Approved/.test(await page.locator('.order-card', { hasText: delivered.orderNumber }).textContent()));
  await page.screenshot({ path: SHOTS + '/16-account-return.png', fullPage: true });
  // other tabs
  await page.click('[data-tab=updates]'); await page.waitForSelector('.tl li'); ok('Updates tab: order timeline events across orders', await page.locator('.tl li').count() > 8);
  await page.click('[data-tab=addresses]'); ok('Addresses tab lists the saved address', /136 Sree Devi Street/.test(await page.locator('#tabBody').textContent()));
  await page.click('#addAddr'); await page.fill('#addrForm [name=pincode]', '600042'); await page.fill('#addrForm [name=city]', 'Chennai'); await page.fill('#addrForm [name=state]', 'Tamil Nadu'); await page.fill('#addrForm [name=line1]', '7 New Road'); await page.click('#addrForm button[type=submit]'); await page.waitForSelector('text=7 New Road');
  ok('address added', (await page.locator('#tabBody .order-card').count()) === 2); await page.click('[data-del]:last-of-type'); await page.waitForTimeout(500); ok('address deleted', (await page.locator('#tabBody .order-card').count()) === 1);
  await page.click('[data-tab=details]'); await page.fill('#profForm [name=name]', 'Muthu N'); await page.click('#profForm button'); await page.waitForSelector('#profMsg:not(:empty)'); ok('profile saved; verified phone shown read-only', /Saved/.test(await page.locator('#profMsg').textContent()) && /Verified/.test(await page.locator('#tabBody').textContent()));
  await ctx.close();

  /* ================= admin switches change the account page ================= */
  await api('/admin/settings', { method: 'PUT', body: { customerLoginEnabled: false, customerSignupEnabled: false } }, owner);
  ({ ctx, page } = await newPage()); await page.goto(`${B}/account.html`); await page.waitForSelector('.empty-state');
  ok('login + sign-up switched off → account page explains and points to order tracking', /aren.t available/.test(await page.locator('.empty-state').textContent()) && await page.locator('#loginForm, #signupForm, #otpLoginBtn').count() === 0); await ctx.close();
  await api('/admin/settings', { method: 'PUT', body: { customerLoginEnabled: true, customerSignupEnabled: false } }, owner);
  ({ ctx, page } = await newPage()); await page.goto(`${B}/account.html`); await page.waitForSelector('#loginForm'); ok('sign-up off, login on → only the login form (plus OTP)', await page.locator('#signupForm').count() === 0 && await page.locator('#otpLoginBtn').count() === 1); await ctx.close();
  await api('/admin/settings', { method: 'PUT', body: { customerSignupEnabled: true } }, owner);

  console.log('\nJS errors:', errs.length ? errs.join(' | ') : 'none'); console.log(`${pass}/${pass + fail} passed`); await browser.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
