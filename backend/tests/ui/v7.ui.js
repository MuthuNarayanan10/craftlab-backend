// Manual courier management: dropdown, AWB + link, customer tracking, WhatsApp text, return window + Need Help.
const { chromium } = require('playwright');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const B = 'http://localhost:4000', SHOTS = process.env.SHOTS || '/tmp/shots7'; require('fs').mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  — ' + x : '')); };
const api = async (path, opts = {}, token) => { const r = await fetch(B + '/api' + path, { ...opts, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const BLOCK = /fonts\.(googleapis|gstatic)\.com|api\.qrserver\.com/;
(async () => {
  const owner = (await api('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'Passw0rd!x' } })).body.token;
  const orders = (await api('/admin/orders?limit=20', {}, owner)).body.orders; const o1 = orders.find((o) => o.orderStatus === 'Packed'), o4 = orders.find((o) => o.orderStatus === 'Delivered');
  const cl = (await api('/admin/couriers', {}, owner)).body.couriers;
  ok('three default couriers', ['Professional Couriers', 'Blue Dart', 'DTDC'].every((n) => cl.some((c) => c.name === n)));
  const add = await api('/admin/couriers', { method: 'POST', body: { name: 'India Post', trackUrl: 'https://track.example/ip?no={AWB}' } }, owner); ok('admin can add a courier', add.status === 201);
  ok('duplicate refused', (await api('/admin/couriers', { method: 'POST', body: { name: 'india post' } }, owner)).status === 409);
  ok('bad link refused', (await api('/admin/couriers', { method: 'POST', body: { name: 'X', trackUrl: 'javascript:alert(1)' } }, owner)).status === 400);
  ok('admin can edit a courier', (await api('/admin/couriers/' + add.body.id, { method: 'PUT', body: { name: 'India Post', trackUrl: 'https://track.example/post?no={AWB}' } }, owner)).status === 200);
  const tmp = await api('/admin/couriers', { method: 'POST', body: { name: 'Temp Courier' } }, owner); ok('admin can remove a courier', (await api('/admin/couriers/' + tmp.body.id, { method: 'DELETE' }, owner)).status === 200);
  ok('bad tracking link on an order is refused', (await api(`/admin/orders/${o1.id}/delivery`, { method: 'PUT', body: { trackingUrl: 'javascript:1' } }, owner)).status === 400);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] }); const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] }); await ctx.route(BLOCK, (r) => r.abort());
  const page = await ctx.newPage(); page.on('pageerror', (e) => errs.push(e.message));

  /* admin: pick courier, AWB, link, WhatsApp */
  await page.goto(`${B}/admin/login.html`); await page.evaluate((t) => localStorage.setItem('cl_admin_token', t), owner);
  await page.goto(`${B}/admin/orders.html`); await page.waitForSelector('#ordersBody tr'); await page.fill('#searchBox', o1.orderNumber); await page.waitForTimeout(900); await page.click('[data-manage]'); await page.waitForSelector('#dPartner');
  const opts = await page.locator('#dPartner option').allTextContents(); ok('dropdown lists the couriers', ['Professional Couriers', 'Blue Dart', 'DTDC', 'India Post'].every((n) => opts.includes(n)), opts.join('|'));
  await page.selectOption('#dPartner', 'Blue Dart'); await page.fill('#dTracking', 'BD778899'); await page.click('#saveCourierManual'); await page.waitForTimeout(900);
  let t = (await api(`/track?orderNumber=${o1.orderNumber}&phone=9876543210`)).body.journey.courier;
  ok('customer API: courier + AWB + the courier page (no prefill when the link has no {AWB})', t.name === 'Blue Dart' && t.awb === 'BD778899' && /bluedart\.com/.test(t.trackingUrl) && t.prefilled === false, JSON.stringify(t));
  await page.waitForSelector('#dPartner'); await page.selectOption('#dPartner', 'India Post'); await page.click('#saveCourierManual'); await page.waitForTimeout(900);
  t = (await api(`/track?orderNumber=${o1.orderNumber}&phone=9876543210`)).body.journey.courier; ok('courier link with {AWB} comes back prefilled', t.prefilled === true && t.trackingUrl.endsWith('no=BD778899'), t.trackingUrl);
  await page.waitForSelector('#dPartner'); await page.selectOption('#dPartner', '__other'); await page.fill('#dPartnerOther', 'Local Tempo'); await page.fill('#dTrackUrl', 'https://tempo.example/t/{AWB}'); await page.click('#saveCourierManual'); await page.waitForTimeout(900);
  t = (await api(`/track?orderNumber=${o1.orderNumber}&phone=9876543210`)).body.journey.courier; ok('"Other" courier + own tracking link works', t.name === 'Local Tempo' && t.trackingUrl === 'https://tempo.example/t/BD778899', JSON.stringify(t));
  await page.waitForSelector('#dPartner'); const hrefOut = await page.locator('a:has-text("WhatsApp: Out for delivery")').getAttribute('href'); const msg = decodeURIComponent(hrefOut.split('text=')[1] || '');
  ok('WhatsApp "out for delivery" text has order no, courier, AWB, tracking link; opens wa.me (not auto-sent)', /^https:\/\/wa\.me\//.test(hrefOut) && msg.includes(o1.orderNumber) && msg.includes('Local Tempo') && msg.includes('BD778899') && msg.includes('https://tempo.example/t/BD778899'), msg);
  const hrefDel = await page.locator('a:has-text("WhatsApp: Delivered")').getAttribute('href'); ok('WhatsApp "delivered" text mentions the return deadline and help page', /Returns are open until/.test(decodeURIComponent(hrefDel)) && /help\.html/.test(decodeURIComponent(hrefDel)));
  await page.screenshot({ path: SHOTS + '/70-admin-courier.png' });
  await page.goto(`${B}/admin/couriers.html`); await page.waitForSelector('.crow input'); ok('Couriers admin page lists couriers', await page.locator('[data-id]').count() >= 4);

  /* customer: tracking page */
  const cp = await ctx.newPage(); await cp.goto(`${B}/order-tracking.html?order=${o1.orderNumber}`); await cp.fill('#fContact', '9876543210'); await cp.click('#lookup button[type=submit]'); await cp.waitForSelector('.trk-hero');
  ok('tracking page: courier, AWB, Track shipment link', /Local Tempo/.test(await cp.locator('.trk-partner').textContent()) && await cp.locator('#awb').textContent() === 'BD778899' && /tempo\.example/.test(await cp.locator('#trackShip').getAttribute('href')));
  await cp.click('#copyAwb'); ok('AWB copies in one click', (await cp.evaluate(() => navigator.clipboard.readText())) === 'BD778899');
  ok('Need Help? link present', await cp.locator('a:text-is("Need Help?")').count() === 1);
  await api(`/admin/orders/${o1.id}/delivery`, { method: 'PUT', body: { partner: 'DTDC', trackingUrl: '' } }, owner);
  await cp.reload(); await cp.fill('#fContact', '9876543210'); await cp.click('#lookup button[type=submit]'); await cp.waitForSelector('.trk-hero');
  ok('page follows the admin’s latest entry (DTDC + note to paste the number)', /DTDC/.test(await cp.locator('.trk-partner').textContent()) && /copies your tracking number/.test(await cp.locator('.trk-card').nth(1).textContent()));
  await cp.click('#trackShip', { modifiers: [] }).catch(() => {});

  /* return window: open, then closed */
  const dp = await ctx.newPage(); await dp.goto(`${B}/order-tracking.html?order=${o4.orderNumber}`); await dp.fill('#fContact', '9876543210'); await dp.click('#lookup button[type=submit]'); await dp.waitForSelector('.trk-hero');
  ok('delivered: return deadline shown, return button available', /You can return this order until/.test(await dp.locator('.trk-card:has(h3:text("Returns"))').textContent()) && await dp.locator('#retBtn:has-text("Return or report")').count() === 1);
  await fetch(B + '/__age-delivery');
  await dp.reload(); await dp.fill('#fContact', '9876543210'); await dp.click('#lookup button[type=submit]'); await dp.waitForSelector('.trk-hero');
  const lab = dp.locator('text=Return Window Closed').first(); ok('after the deadline: red “Return Window Closed” label', await lab.count() === 1 && /rgb\(179, 38, 30\)/.test(await lab.evaluate((e) => getComputedStyle(e).color)));
  ok('after the deadline: no return button, but Need Help? still there and goes to help page', await dp.locator('a:has-text("Return or report")').count() === 0 && /help\.html\?order=/.test(await dp.locator('a:text-is("Need Help?")').getAttribute('href')));
  await dp.screenshot({ path: SHOTS + '/71-return-closed.png', fullPage: true });
  const ret = await api('/returns/eligibility', {}, ''); // (server rule is covered by returns tests)
  ok('help page reachable', (await fetch(B + '/help.html')).status === 200);
  ok('no page errors', errs.length === 0, errs.join(' | ')); await browser.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
