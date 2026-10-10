// Help page ticket form: topic → category → sub-category → product pickers, "Ask us" link from a product page, submission.
const { chromium } = require('playwright'); const assert = require('assert');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'; const B = 'http://localhost:4000';
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] }); const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${B}/help.html`); await page.waitForTimeout(1200);
  assert.equal(await page.locator('#tCatWrap').isHidden(), true, 'category hidden until a product topic is chosen');
  await page.selectOption('#tType', 'Product question'); await page.waitForTimeout(300);
  assert.equal(await page.locator('#tCatWrap').isVisible(), true, 'category shows for product questions');
  const cats = await page.locator('#tCat option').allTextContents(); assert.ok(cats.length > 1, 'categories loaded: ' + cats);
  await page.selectOption('#tCat', { index: 1 }); await page.waitForTimeout(300);
  assert.equal(await page.locator('#tProdWrap').isVisible(), true, 'products for that category are listed');
  await page.selectOption('#tType', 'Order status'); await page.waitForTimeout(200);
  assert.equal(await page.locator('#tCatWrap').isHidden(), true, 'pickers hide again for other topics');
  // from a product page
  await page.goto(`${B}/product.html?slug=sculptural-wall-hook-rack`); await page.waitForTimeout(1000);
  await page.locator('a:has-text("Ask us")').click(); await page.waitForURL(/help\.html/); await page.waitForTimeout(1500);
  assert.equal(await page.inputValue('#tType'), 'Product question'); assert.equal(await page.inputValue('#tProd'), 'sculptural-wall-hook-rack');
  await page.fill('#tName', 'Test Buyer'); await page.fill('#tEmail', 'buyer@example.com'); await page.fill('#tSubject', 'Mounting on brick'); await page.fill('#tMsg', 'Which plugs do you recommend for brick?');
  await page.click('#tBtn'); await page.waitForSelector('#tStatus strong', { timeout: 8000 });
  assert.match(await page.locator('#tStatus strong').innerText(), /^TKT-\d+/);
  assert.deepEqual(errors, [], 'no page errors'); console.log('tickets UI OK'); await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
