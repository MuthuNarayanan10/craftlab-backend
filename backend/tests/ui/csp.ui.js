// Loads key storefront + admin pages with the Content-Security-Policy from frontend/_headers ENFORCED and reports every violation.
const { chromium } = require('playwright'); const fs = require('fs');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const B = 'http://localhost:4000';
const hdrs = fs.readFileSync(__dirname + '/../../../frontend/_headers', 'utf8');
const CSP = (hdrs.match(/Content-Security-Policy(?:-Report-Only)?: (.+)/) || [])[1].trim();
const BLOCK = /fonts\.(googleapis|gstatic)\.com|api\.qrserver\.com|checkout\.razorpay\.com|gstatic\.com\/firebasejs|postalpincode/;
(async () => {
  const log = JSON.parse(fs.readFileSync('/tmp/ui-server.log', 'utf8').split('\n').find((l) => l.includes('"ready":true')));
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(BLOCK, (r) => r.abort());
  await ctx.route(/\.html(\?.*)?$|\/$/, async (route) => { const r = await route.fetch(); await route.fulfill({ response: r, headers: { ...r.headers(), 'content-security-policy': CSP } }); });
  const page = await ctx.newPage(); const viol = new Set();
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) viol.add(page.url().split('/').pop() + ' :: ' + m.text().slice(0, 220)); });
  page.on('pageerror', (e) => viol.add('JS ERROR ' + page.url().split('/').pop() + ' :: ' + e.message));
  const pages = ['index.html', 'shop.html', 'shop.html?category=Wall%20Organizers', 'product.html?slug=sculptural-wall-hook-rack', 'cart.html', 'search.html?q=rack', 'help.html', 'about.html', 'account.html', 'order-tracking.html', 'wishlist.html', 'sitemap.html', 'policies.html'];
  for (const p of pages) { await page.goto(`${B}/${p}`); await page.waitForTimeout(900); }
  // add to cart → open cart drawer → checkout modal
  await page.goto(`${B}/product.html?slug=sculptural-wall-hook-rack`); await page.waitForTimeout(800);
  const add = page.locator('#addToCartBtn, [data-add-to-cart], button:has-text("Add to cart")').first(); if (await add.count()) { await add.click(); await page.waitForTimeout(800); }
  const co = page.locator('[data-checkout], button:has-text("Checkout")').first(); if (await co.count()) { await co.click().catch(() => {}); await page.waitForTimeout(1200); }
  // admin
  await page.goto(`${B}/admin/login.html`); await page.fill('input[type=email]', 'owner@shop.test'); await page.fill('input[type=password]', 'Passw0rd!x'); await Promise.all([page.waitForURL(/admin\/(index\.html)?$/), page.click('button[type=submit]')]);
  for (const p of ['index.html', 'orders.html', 'products.html', 'categories.html', 'customers.html', 'integrations.html', 'settings.html', 'shipping.html', 'delivery.html', 'payments.html']) { await page.goto(`${B}/admin/${p}`); await page.waitForTimeout(900); }
  console.log(viol.size ? 'VIOLATIONS (' + viol.size + '):\n' + [...viol].join('\n') : 'No CSP violations on ' + (pages.length + 10) + ' pages + cart/checkout');
  await browser.close();
})();
