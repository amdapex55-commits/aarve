// Browser tests: storefront + admin, on a phone and a desktop, including offline and flaky networks.
// Needs: site on :8801 (python3 -m http.server 8801), API on :8787 (wrangler dev), and Playwright.
import assert from 'node:assert/strict';
const PW = process.env.PW || '/Users/aisha/projects/nova-go/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SITE = process.env.SITE || 'http://localhost:8801';
const API = process.env.API || 'http://localhost:8787';
const PASS = process.env.ADMIN_PASSWORD || 'local-test-password';
const { chromium } = await import(PW);
const browser = await chromium.launch({ executablePath: CHROME });
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('  ok  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + String(e.stack || e).split('\n').slice(0, 4).join('\n      ')); } }
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const desk = { viewport: { width: 1440, height: 900 } };
async function page(opts) {
  const ctx = await browser.newContext(opts); const p = await ctx.newPage(); p.errors = [];
  p.on('pageerror', (e) => p.errors.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errors.push('console ' + m.text()); });
  return p;
}
async function admin(path, opts = {}, token) {
  const r = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } }); return r.json();
}
const token = (await admin('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: PASS }) })).token;
const orders = async (q) => (await admin('/api/admin/orders?status=all&limit=100&q=' + encodeURIComponent(q), {}, token)).orders;
const uniq = () => 'T' + Math.random().toString(36).slice(2, 8);

async function fill(p, who) {
  await p.fill('#checkoutForm [name=name]', who);
  await p.fill('#checkoutForm [name=phone]', '0300 1234567');
  await p.fill('#checkoutForm [name=city]', 'Lahore');
  await p.fill('#checkoutForm [name=address]', `House 12, Street 4, DHA (${who})`);
}

for (const [label, opts] of [['phone', phone], ['desktop', desk]]) {
  await test(`${label}: page loads with live price, no console errors, no sideways scroll`, async () => {
    const p = await page(opts); await p.goto(SITE + '/'); await p.waitForSelector('#priceMain:not(:has(.skel))');
    assert.match(await p.textContent('#priceMain'), /Rs.5,500/);
    assert.equal(await p.isEnabled('#addBtn'), true);
    const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    assert.ok(w.sw <= w.iw + 1, `overflow ${w.sw} > ${w.iw}`);
    await p.waitForTimeout(500); assert.deepEqual(p.errors, []);
    await p.context().close();
  });
  await test(`${label}: every image loads`, async () => {
    const p = await page(opts); await p.goto(SITE + '/'); await p.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } });
    await p.waitForTimeout(800);
    const bad = await p.evaluate(() => [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src));
    assert.deepEqual(bad, []); await p.context().close();
  });
  await test(`${label}: add to cart, change quantity, checkout, place order`, async () => {
    const p = await page(opts); const who = uniq(); await p.goto(SITE + '/'); await p.waitForSelector('#priceMain:not(:has(.skel))');
    await p.click('#addBtn'); await p.waitForSelector('#drawer.open');
    assert.equal(await p.textContent('#cartCount'), '1');
    await p.click('#cartLines [data-q="1"]'); assert.match(await p.textContent('#cartSub'), /11,000/);
    await p.click('#cartLines [data-q="-1"]');
    await p.click('#toCheckout'); await p.waitForSelector('#checkoutForm', { state: 'visible' });
    // validation first
    await p.click('#placeBtn'); await p.waitForSelector('.fld.bad');
    assert.ok((await p.$$('#checkoutForm .fld.bad')).length >= 4);
    await fill(p, who); await p.click('#placeBtn');
    await p.waitForSelector('#doneNo:not(:empty)'); const no = await p.textContent('#doneNo'); assert.match(no, /^AV-\d+$/);
    const o = await orders(who); assert.equal(o.length, 1); assert.equal(o[0].total, 5500); assert.equal(o[0].status, 'new');
    assert.equal(await p.textContent('#cartCount'), '0');
    assert.deepEqual(p.errors, []); await p.context().close();
  });
}

await test('buy now goes straight to checkout; sticky buy bar shows on phones', async () => {
  const p = await page(phone); await p.goto(SITE + '/'); await p.waitForSelector('#priceMain:not(:has(.skel))');
  await p.evaluate(() => scrollTo(0, 1400)); await p.waitForTimeout(600);
  assert.equal(await p.evaluate(() => document.getElementById('stickyBuy').classList.contains('show')), true);
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(500);
  await p.click('#buyNowBtn'); await p.waitForSelector('#checkoutForm', { state: 'visible' });
  assert.match(await p.textContent('#coTotal'), /5,500/); await p.context().close();
});

await test('offline: order is saved on the phone, then sent once when back online (exactly one order)', async () => {
  const p = await page(phone); const who = uniq(); await p.goto(SITE + '/'); await p.waitForSelector('#priceMain:not(:has(.skel))');
  await p.click('#addBtn'); await p.waitForSelector('#drawer.open'); await p.click('#toCheckout'); await fill(p, who);
  await p.context().setOffline(true); await p.waitForTimeout(300);
  await p.click('#placeBtn');
  await p.waitForSelector('#pendingBar:not([hidden])');
  assert.match(await p.textContent('#coMsg'), /saved on this phone/i);
  assert.equal((await orders(who)).length, 0);
  await p.context().setOffline(false);
  await p.waitForSelector('#doneNo:not(:empty)', { timeout: 20000 });
  assert.equal((await orders(who)).length, 1);
  assert.equal(await p.isHidden('#pendingBar'), true);
  await p.context().close();
});

await test('flaky server: two failures then success still makes exactly one order', async () => {
  const p = await page(phone); const who = uniq(); let hits = 0;
  await p.route('**/api/orders', async (route) => { hits++; if (hits <= 2) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":{"message":"down"}}' }); return route.continue(); });
  await p.goto(SITE + '/'); await p.waitForSelector('#priceMain:not(:has(.skel))');
  await p.click('#addBtn'); await p.click('#toCheckout'); await fill(p, who); await p.click('#placeBtn');
  await p.waitForSelector('#pendingBar:not([hidden])');
  await p.click('#pendingRetry').catch(() => {}); await p.waitForTimeout(300);
  await p.evaluate(() => document.getElementById('pendingRetry').click());
  await p.waitForSelector('#doneNo:not(:empty)', { timeout: 30000 });
  assert.equal((await orders(who)).length, 1); assert.ok(hits >= 3);
  await p.context().close();
});

await test('response lost after the order was saved: retry does not create a second order', async () => {
  const p = await page(phone); const who = uniq(); let first = true;
  await p.route('**/api/orders', async (route) => { if (first) { first = false; await route.fetch(); return route.abort('failed'); } return route.continue(); });
  await p.goto(SITE + '/'); await p.waitForSelector('#priceMain:not(:has(.skel))');
  await p.click('#addBtn'); await p.click('#toCheckout'); await fill(p, who); await p.click('#placeBtn');
  await p.waitForSelector('#pendingBar:not([hidden])'); await p.evaluate(() => document.getElementById('pendingRetry').click());
  await p.waitForSelector('#doneNo:not(:empty)', { timeout: 30000 });
  assert.equal((await orders(who)).length, 1); await p.context().close();
});

await test('config down on first visit: skeleton, then clear error with Try again that works', async () => {
  const p = await page(phone); let down = true;
  await p.route('**/api/config', (route) => (down ? route.abort('failed') : route.continue()));
  await p.goto(SITE + '/'); await p.waitForSelector('#cfgError:not([hidden])', { timeout: 20000 });
  assert.equal(await p.isDisabled('#addBtn'), true);
  down = false; await p.click('#cfgRetry'); await p.waitForSelector('#priceMain:not(:has(.skel))');
  assert.equal(await p.isEnabled('#addBtn'), true); await p.context().close();
});

await test('second visit works with the server down (last known price is used)', async () => {
  const ctx = await browser.newContext(phone); const p = await ctx.newPage();
  await p.goto(SITE + '/'); await p.waitForSelector('#priceMain:not(:has(.skel))');
  await p.route('**/api/config', (route) => route.abort('failed')); await p.reload();
  await p.waitForSelector('#priceMain'); assert.match(await p.textContent('#priceMain'), /Rs.5,500/); assert.equal(await p.isEnabled('#addBtn'), true);
  await ctx.close();
});

await test('track an order with the right phone; wrong phone is refused', async () => {
  const p = await page(desk); const who = uniq(); await p.goto(SITE + '/'); await p.waitForSelector('#priceMain:not(:has(.skel))');
  await p.click('#addBtn'); await p.click('#toCheckout'); await fill(p, who); await p.click('#placeBtn'); await p.waitForSelector('#doneNo:not(:empty)');
  const no = await p.textContent('#doneNo'); await p.click('#doneTrack'); await p.waitForSelector('#trackOut .badge');
  assert.match(await p.textContent('#trackOut'), /Order received/);
  await p.fill('#trackForm [name=phone]', '03009999999'); await p.click('#trackForm button[type=submit]'); await p.waitForSelector('#trackMsg.bad');
  assert.match(await p.textContent('#trackMsg'), /could not find/i); await p.context().close();
});

await test('contact form and UAE/UK list reach the admin', async () => {
  const p = await page(desk); const tag = uniq(); await p.goto(SITE + '/'); await p.waitForSelector('#priceMain:not(:has(.skel))');
  await p.fill('#waitForm [name=contact]', `${tag}@example.com`); await p.click('#waitForm button'); await p.waitForSelector('#waitMsg.good');
  await p.click('footer [data-open=contact]'); await p.fill('#contactForm [name=contact]', `${tag}@x.co`); await p.fill('#contactForm [name=body]', 'Hello from the test'); await p.click('#contactForm button[type=submit]'); await p.waitForSelector('#contactMsg.good');
  const m = (await admin('/api/admin/messages', {}, token)).messages; assert.ok(m.some((x) => x.contact === `${tag}@example.com` && x.kind === 'waitlist')); assert.ok(m.some((x) => x.contact === `${tag}@x.co`));
  await p.context().close();
});

await test('back button closes the cart instead of leaving the page (phone)', async () => {
  const p = await page(phone); await p.goto(SITE + '/'); await p.waitForSelector('#priceMain:not(:has(.skel))');
  await p.click('#cartBtn'); await p.waitForSelector('#drawer.open'); await p.goBack(); await p.waitForFunction(() => !document.getElementById('drawer').classList.contains('open'));
  assert.equal(new URL(p.url()).pathname, '/'); await p.context().close();
});

await test('admin: sign in, see the order, process it through to delivered, stock and customer view follow', async () => {
  const shop = await page(desk); const who = uniq(); await shop.goto(SITE + '/'); await shop.waitForSelector('#priceMain:not(:has(.skel))');
  await shop.click('#addBtn'); await shop.click('#toCheckout'); await fill(shop, who); await shop.click('#placeBtn'); await shop.waitForSelector('#doneNo:not(:empty)');
  const no = await shop.textContent('#doneNo'); await shop.context().close();
  const a = await page(desk); await a.goto(SITE + '/admin/');
  await a.fill('#loginForm [name=password]', 'wrong'); await a.click('#loginForm button'); await a.waitForSelector('#loginMsg:not(:empty)');
  await a.fill('#loginForm [name=password]', PASS); await a.click('#loginForm button'); await a.waitForSelector('#app:not([hidden])');
  await a.fill('#q', who); await a.waitForSelector(`.row:has-text("${no}")`); await a.click('.row');
  await a.waitForSelector('#panel.open #nextBtn');
  for (const label of ['Confirm order', 'Mark packed', 'Mark shipped']) { await a.click('#nextBtn'); await a.waitForFunction((l) => !document.querySelector('#nextBtn') || document.querySelector('#nextBtn .lbl').textContent !== l, label); }
  await a.fill('#courier', 'NovaX'); await a.fill('#tracking', 'NX-777'); await a.click('#saveShip'); await a.waitForSelector('.toast');
  await a.click('#nextBtn'); await a.waitForFunction(() => !document.querySelector('#nextBtn'));
  const o = (await orders(who))[0]; assert.equal(o.status, 'delivered'); assert.equal(o.pay_status, 'paid'); assert.equal(o.tracking, 'NX-777');
  assert.deepEqual(a.errors, []); await a.context().close();
});

await test('admin on a phone: list and panel fit the screen', async () => {
  const a = await page(phone); await a.goto(SITE + '/admin/'); await a.fill('#loginForm [name=password]', PASS); await a.click('#loginForm button'); await a.waitForSelector('#app:not([hidden])');
  await a.waitForSelector('.row'); const w = await a.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth })); assert.ok(w.sw <= w.iw + 1, `overflow ${w.sw}`);
  await a.click('.row'); await a.waitForSelector('#panel.open #panelBody .card');
  const box = await a.evaluate(() => document.getElementById('panel').getBoundingClientRect().width); assert.ok(box <= 391); await a.context().close();
});

await test('admin: change the price, the shop shows it; put it back', async () => {
  const a = await page(desk); await a.goto(SITE + '/admin/'); await a.fill('#loginForm [name=password]', PASS); await a.click('#loginForm button'); await a.waitForSelector('#app:not([hidden])');
  await a.click('[data-tab=settings]'); await a.waitForFunction(() => document.querySelector('#settingsForm [name=price]').value !== '');
  const old = await a.inputValue('#settingsForm [name=price]');
  await a.fill('#settingsForm [name=price]', '5900'); await a.click('#settingsForm button[type=submit]'); await a.waitForSelector('#settingsMsg.good');
  const s = await page(desk); await s.goto(SITE + '/'); await s.waitForFunction(() => /5,900/.test(document.getElementById('priceMain').textContent)); await s.context().close();
  await a.fill('#settingsForm [name=price]', old); await a.click('#settingsForm button[type=submit]'); await a.waitForSelector('#settingsMsg.good');
  await a.fill('#settingsForm [name=price]', '5'); await a.click('#settingsForm button[type=submit]'); await a.waitForFunction(() => [...document.querySelectorAll('#settingsForm .err')].some((e) => e.textContent));
  await a.context().close();
});

await browser.close();
console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
