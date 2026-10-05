// Browser tests for the admin console against the REAL backend (tests/support/ui-server.js).
const { chromium } = require('playwright');
const CHROME = process.env.CHROME || '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
const B = 'http://localhost:4000', SHOTS = process.env.SHOTS || '/tmp/shots2'; require('fs').mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  — ' + x : '')); };
const api = async (path, opts = {}, token) => { const r = await fetch(B + '/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const BLOCK = /fonts\.(googleapis|gstatic)\.com|api\.qrserver\.com/;
(async () => {
  const log = JSON.parse(require('fs').readFileSync('/tmp/ui-server.log', 'utf8').split('\n').find((l) => l.includes('"ready":true')));
  const owner = (await api('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'Passw0rd!x' } })).body.token; const cust = log.customerToken;
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] }); const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await ctx.route(BLOCK, (r) => r.abort());
  const page = await ctx.newPage(); page.on('pageerror', (e) => errs.push(page.url().split('/').pop() + ': ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push(page.url().split('/').pop() + ': ' + m.text()); });
  page.on('dialog', async (d) => { const m = d.message(); await d.accept(/Reason/i.test(m) ? 'test cancel' : /Refund amount/.test(m) ? undefined : /Mobile number/.test(m) ? '9999999999' : /payout|How did you/.test(m) ? 'UPI-TEST-1' : undefined); });
  const go = async (p) => { await page.goto(`${B}/admin/${p}`); await page.waitForTimeout(700); };
  const toast = async () => { await page.waitForSelector('#adminToast.show', { timeout: 6000 }); return page.locator('#adminToast').textContent(); };

  /* ---- login ---- */
  await page.goto(`${B}/admin/login.html`); await page.fill('input[type=email]', 'owner@shop.test'); await page.fill('input[type=password]', 'wrong'); await page.click('button[type=submit]'); await page.waitForTimeout(800);
  ok('wrong password stays on the login page', /login/.test(page.url()));
  await page.fill('input[type=password]', 'Passw0rd!x'); await Promise.all([page.waitForURL(/admin\/(index\.html)?$/, { timeout: 8000 }), page.click('button[type=submit]')]);
  await page.waitForSelector('.kpi .k-value', { timeout: 8000 }); ok('login works and lands on the dashboard', await page.locator('.kpi').count() > 3);

  /* ---- dashboard ---- */
  await page.waitForTimeout(1200); const dash = await page.locator('#dash').textContent();
  ok('dashboard shows the actionable queue + payments today', /Orders to pack/.test(dash) && /Orders in transit/.test(dash) && /Payments today/.test(dash) && /Return requests to review/.test(dash));
  await page.screenshot({ path: SHOTS + '/20-admin-dashboard.png', fullPage: true });

  /* ---- DELIVERY METHODS (the new requirement) ---- */
  await go('delivery.html');
  ok('delivery page lists Standard, Express and Local delivery with ON/OFF', await page.locator('.method-card').count() === 3 && (await page.locator('.method-card .badge:text-is("ON")').count()) === 3);
  await page.screenshot({ path: SHOTS + '/21-admin-delivery.png', fullPage: true });
  await page.locator('[data-toggle=manual] + span').click(); ok('toggling OFF is saved', /Switched OFF/.test(await toast()));
  let methods = (await api('/admin/delivery', {}, owner)).body; ok('…and the API agrees', methods.find((m) => m.key === 'manual').enabled === false);
  ok('the storefront no longer offers it', !(await (await fetch(B + '/api/delivery/options?pincode=600002&subtotal=2499')).json()).options.some((o) => o.key === 'manual'));
  await page.waitForTimeout(500); await page.locator('[data-toggle=manual] + span').click(); await page.waitForTimeout(700); ok('toggling back ON works', (await api('/admin/delivery', {}, owner)).body.find((m) => m.key === 'manual').enabled === true);
  await page.click('[data-edit=express]'); await page.fill('form[data-form=express] [name=fee]', '199'); await page.fill('form[data-form=express] [name=freeAbove]', '5000'); await page.click('form[data-form=express] button[type=submit]'); await toast();
  methods = (await api('/admin/delivery', {}, owner)).body; ok('editing fee + free-above saves', methods.find((m) => m.key === 'express').fee === 199 && methods.find((m) => m.key === 'express').freeAbove === 5000);
  await page.click('#addBtn'); await page.fill('form[data-form=""] [name=name]', 'Same-day Chennai'); await page.selectOption('form[data-form=""] [name=type]', 'manual'); await page.fill('form[data-form=""] [name=fee]', '99'); await page.fill('form[data-form=""] [name=pincodePrefixes]', '600'); await page.fill('form[data-form=""] [name=etaMaxDays]', '1');
  await page.screenshot({ path: SHOTS + '/22-admin-delivery-new.png' }); await page.click('form[data-form=""] button[type=submit]'); await toast(); await page.waitForTimeout(500);
  ok('a custom method can be added', (await api('/admin/delivery', {}, owner)).body.some((m) => m.key === 'same-day-chennai' && m.type === 'manual'));
  await api('/admin/delivery/express', { method: 'PUT', body: { enabled: false } }, owner); await api('/admin/delivery/manual', { method: 'PUT', body: { enabled: false } }, owner); await api('/admin/delivery/same-day-chennai', { method: 'PUT', body: { enabled: false } }, owner);
  await go('delivery.html'); await page.locator('[data-toggle=standard] + span').click(); const t = await toast(); ok('the last method cannot be switched off', /at least one/i.test(t), t);
  await page.click('[data-edit=same-day-chennai]'); await page.click('[data-delete=same-day-chennai]'); await toast(); ok('a custom method can be deleted', !(await api('/admin/delivery', {}, owner)).body.some((m) => m.key === 'same-day-chennai'));
  await api('/admin/delivery/express', { method: 'PUT', body: { enabled: true, fee: 149, freeAbove: 0 } }, owner); await api('/admin/delivery/manual', { method: 'PUT', body: { enabled: true } }, owner);

  /* ---- ORDERS ---- */
  await go('orders.html'); const rows = await page.locator('#ordersBody tr').count(); ok('orders list loads with delivery method column', rows >= 4 && /Local delivery by our team/.test(await page.locator('#ordersBody').textContent()));
  await page.fill('#searchBox', 'CL-1003'); await page.waitForTimeout(900); ok('search narrows to one order', await page.locator('#ordersBody tr').count() === 1);
  await page.click('[data-manage]'); await page.waitForSelector('#orderModal.open #saveStatus'); await page.waitForTimeout(400);
  ok('manual order: delivery-person form with saved person; no courier controls', (await page.inputValue('#asName')) === 'Rajan' && await page.locator('#shipCreate').count() === 0);
  ok('timeline + journey are shown', await page.locator('.tl li').count() >= 6 && await page.locator('.stepline b').count() === 8);
  ok('status dropdown only offers valid next steps', (await page.locator('#mStatus option').allTextContents()).join('|').includes('Delivered') && !(await page.locator('#mStatus option').allTextContents()).join('|').includes('Pending'));
  await page.screenshot({ path: SHOTS + '/23-admin-order-manual.png' });
  await page.fill('#asName', 'Suresh'); await page.fill('#asPhone', '+919000000010'); await page.click('#saveAssignee'); await toast(); await page.waitForTimeout(600);
  const oid = (await api('/admin/orders?q=CL-1003', {}, owner)).body.orders[0].id; ok('reassigning the delivery person saves', (await api('/admin/orders/' + oid, {}, owner)).body.delivery.assignee.name === 'Suresh');
  await page.fill('#noteText', 'Customer asked for evening delivery'); await page.click('#noteInternal'); await toast(); await page.waitForTimeout(500); ok('internal note appears on the timeline, marked internal', /evening delivery/.test(await page.locator('.tl').textContent()) && await page.locator('.tl li.internal').count() >= 1);
  await page.selectOption('#mStatus', 'Delivered'); await page.click('#saveStatus'); await toast(); await page.waitForTimeout(600);
  ok('marking Delivered collects the COD cash and closes the order', (await api('/admin/orders/' + oid, {}, owner)).body.paymentStatus === 'Paid');
  await page.keyboard.press('Escape'); await page.fill('#searchBox', 'CL-1001'); await page.waitForTimeout(900); await page.click('[data-manage]'); await page.waitForSelector('#shipCreate');
  ok('courier order: booking controls present', await page.locator('#shipCreate').count() === 1 && await page.locator('#asName').count() === 0);
  await page.waitForSelector('#adminToast:not(.show)'); await page.click('#shipCreate'); const tt = await toast(); ok('booking without a connected courier explains what to do (no crash)', /Integrations/.test(tt), tt);
  await page.keyboard.press('Escape');

  /* ---- RETURNS: customer asks, admin walks it to a refund ---- */
  const deliv = (await api('/admin/orders?status=Delivered', {}, owner)).body.orders.find((o) => o.items[0].qty === 2);
  const rr = await api('/returns', { method: 'POST', body: { orderId: deliv.id, items: [{ index: 0, qty: 1 }], reason: 'Wrong item received' } }, cust); ok('(setup) customer requested a return', rr.status === 201);
  await go('returns.html'); ok('returns list shows the request', /CL-1004/.test(await page.locator('#tableBody').textContent())); await page.click('[data-open]'); await page.waitForSelector('#rNext');
  await page.selectOption('#rNext', 'REJECTED'); await page.click('#rGo'); ok('rejection without a reason is refused', /why|reason/i.test(await toast()));
  for (const [st, extra] of [['APPROVED'], ['PICKUP_SCHEDULED', async () => { await page.fill('#pkDate', '2026-10-06'); await page.fill('#pkCourier', 'Delhivery RET9'); }], ['PICKED_UP'], ['RECEIVED'], ['INSPECTION'], ['REFUND_PENDING', async () => { await page.selectOption('#inRestock', '1'); }]]) {
    await page.waitForSelector('#rNext'); await page.selectOption('#rNext', st); if (extra) await extra(); await page.click('#rGo'); await page.waitForTimeout(900); }
  ok('return walked through every step to “Refund being processed”', (await api('/admin/returns/' + rr.body.id, {}, owner)).body.status === 'REFUND_PENDING');
  await page.screenshot({ path: SHOTS + '/24-admin-return.png', fullPage: true });
  await page.waitForSelector('#rfGo'); await page.fill('#rfRef', 'UPI-REF-1'); await page.click('#rfGo'); await toast(); await page.waitForTimeout(700);
  const done = (await api('/admin/returns/' + rr.body.id, {}, owner)).body; ok('COD refund recorded with its payout reference; return is Refunded', done.status === 'REFUNDED' && done.refund.amount === 2499);

  /* ---- other pages ---- */
  await go('payments.html'); ok('payments page: summary + table', /Successful/.test(await page.locator('#kpis').textContent()) && await page.locator('#body tr').count() >= 4); await page.screenshot({ path: SHOTS + '/25-admin-payments.png' });
  await go('inventory.html'); await page.click('[data-adj]:first-of-type'); await page.fill('#adjDelta', '5'); await page.selectOption('#adjReason', 'New stock received'); await page.click('#adjSave'); await toast(); await page.waitForTimeout(500);
  await page.click('.tabs button[data-t=ledger]'); await page.waitForTimeout(700); ok('inventory adjustment lands in the stock ledger', /manual adjustment/.test(await page.locator('#mv').textContent()) && /\+5/.test(await page.locator('#mv').textContent()));
  await go('shipping.html'); ok('shipping queue: orders to fulfil', await page.locator('#body tr').count() >= 1); await page.click('.tabs button[data-t=road]'); await page.waitForTimeout(700); ok('…and on the road', /Rajan|DL778899|Suresh/.test(await page.locator('#body').textContent()) || await page.locator('#body tr').count() >= 1);
  await go('purchase-orders.html'); await page.click('#newBtn'); await page.fill('#lines .l-desc', 'Sculptural rack batch'); await page.selectOption('#lines .l-prod', { index: 1 }); await page.fill('#lines .l-qty', '10'); await page.fill('#lines .l-cost', '900'); await page.click('#nSave'); await toast(); await page.waitForTimeout(600);
  await page.click('[data-open]'); await page.waitForSelector('#poBody [data-st=Sent]'); await page.click('[data-st=Sent]'); await page.waitForTimeout(700); await page.click('[data-st=Confirmed]'); await page.waitForTimeout(700);
  await page.fill('.rcv', '10'); await page.click('#rcvBtn'); await toast(); await page.waitForTimeout(700); await page.fill('#ivNo', 'KW/1'); await page.fill('#ivAmt', '9000'); await page.click('#ivSave'); await toast(); await page.waitForTimeout(700);
  await page.click('#ivVerify'); await page.waitForTimeout(800); await page.fill('#pyAmt', '9000'); await page.fill('#pyRef', 'NEFT1'); await page.click('#pyGo'); await toast(); await page.waitForTimeout(700);
  const pos = (await api('/admin/purchase-orders', {}, owner)).body.purchaseOrders[0]; ok('purchase order: created → sent → confirmed → received → invoice verified → paid in full', pos.status === 'Received' && pos.paymentStatus === 'Paid' && pos.outstanding === 0, `${pos.poNumber} ${pos.status}/${pos.paymentStatus}`);
  await page.screenshot({ path: SHOTS + '/26-admin-po.png' });
  await go('analytics.html'); ok('analytics: KPIs + daily chart', /Revenue/.test(await page.locator('#out').textContent()) && await page.locator('#out svg .bar').count() >= 30); await page.click('#ranges [data-r="7d"]'); await page.waitForTimeout(800); ok('7-day range re-renders', await page.locator('#out svg .bar').count() === 7); await page.screenshot({ path: SHOTS + '/27-admin-analytics.png', fullPage: true });
  await go('notifications.html'); ok('notification log page loads', /Sent/.test(await page.locator('#kpis').textContent()));
  await go('audit.html'); ok('audit log: shows owner actions with before/after', /Switched OFF|switched OFF/.test(await page.locator('#body').textContent()) && await page.locator('details').count() >= 1); await page.screenshot({ path: SHOTS + '/28-admin-audit.png' });
  await go('integrations.html'); await page.fill('[data-p=shiprocket] [data-secret=email]', 'ops@shop.test'); await page.fill('[data-p=shiprocket] [data-secret=password]', 'SuperSecret-9876'); await page.fill('[data-p=shiprocket] [data-config=pickupLocation]', 'Primary'); await page.click('[data-p=shiprocket] [data-save]'); await toast(); await page.waitForTimeout(600);
  const ig = (await api('/admin/integrations', {}, owner)).body.providers.find((p) => p.id === 'shiprocket').saved; ok('integration saved; the secret is never returned, only a masked hint', ig.hasSecrets && /••••9876/.test(JSON.stringify(ig.secretHints)) && !JSON.stringify(ig).includes('SuperSecret'));
  ok('webhook URL for the courier is shown', /webhooks\/courier\/shiprocket\?token=/.test(await page.locator('[data-p=shiprocket] input[readonly]').inputValue())); await page.screenshot({ path: SHOTS + '/29-admin-integrations.png', fullPage: true });
  await go('settings.html'); ok('settings: auth switches reflect saved values', await page.locator('[name=guestCheckoutEnabled]').isChecked() && await page.locator('[name=customerLoginEnabled]').isChecked());
  await page.locator('[name=guestCheckoutEnabled]').evaluate((e) => e.click()); await page.click('#saveBtn'); await toast(); await page.waitForTimeout(500); ok('turning guest checkout off in the UI is enforced by the server', (await api('/config/public')).body.auth.guestCheckoutEnabled === false);
  await page.locator('[name=guestCheckoutEnabled]').evaluate((e) => e.click()); await page.click('#saveBtn'); await toast(); await page.screenshot({ path: SHOTS + '/30-admin-settings.png', fullPage: true });
  await page.fill('#pwCur', 'wrong-password-1'); await page.fill('#pwNew', 'A-brand-new-passphrase-9'); await page.fill('#pwNew2', 'A-brand-new-passphrase-9'); await page.click('#pwForm button'); await page.waitForTimeout(700);
  ok('change password: a wrong current password is refused with a clear message', /current password is incorrect/.test(await page.locator('#pwMsg').textContent()));
  await page.fill('#pwCur', 'Passw0rd!x'); await page.fill('#pwNew', 'short'); await page.fill('#pwNew2', 'short'); await page.click('#pwForm button'); await page.waitForTimeout(600); ok('a weak new password is refused', /12 characters/.test(await page.locator('#pwMsg').textContent()));
  await page.fill('#pwNew', 'A-brand-new-passphrase-9'); await page.fill('#pwNew2', 'A-brand-new-passphrase-9'); await page.fill('#pwCur', 'Passw0rd!x'); await page.click('#pwForm button'); await page.waitForTimeout(900);
  ok('password changed from the admin screen; the new one logs in and the old one does not', /Password changed/.test(await page.locator('#pwMsg').textContent()) && (await api('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'A-brand-new-passphrase-9' } })).status === 200 && (await api('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'Passw0rd!x' } })).status === 401);
  await go('customers.html'); ok('customers: paginated list with verified badge', /verified/.test(await page.locator('#tableBody').textContent()));

  /* ---- phone layout for every admin page ---- */
  const m = await browser.newContext({ viewport: { width: 390, height: 844 } }); await m.route(BLOCK, (r) => r.abort()); const mp = await m.newPage(); await mp.goto(`${B}/admin/login.html`); await mp.evaluate((t) => localStorage.setItem('cl_admin_token', t), owner);
  const over = []; for (const f of ['index', 'orders', 'delivery', 'returns', 'payments', 'inventory', 'shipping', 'purchase-orders', 'analytics', 'notifications', 'audit', 'integrations', 'settings', 'customers', 'products', 'suppliers', 'quotations', 'coupons', 'abandoned-carts', 'tax']) { await mp.goto(`${B}/admin/${f}.html`); await mp.waitForTimeout(500); if (await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) over.push(f); }
  ok('all 20 admin pages fit a phone screen', !over.length, over.join(','));
  const mp2 = await m.newPage(); await mp2.goto(`${B}/admin/delivery.html`); await mp2.waitForTimeout(700); await mp2.screenshot({ path: SHOTS + '/31-admin-delivery-mobile.png', fullPage: true });
  console.log('\nJS errors:', errs.length ? '\n' + errs.join('\n') : 'none'); console.log(`${pass}/${pass + fail} passed`); await browser.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
