// End to end API checks. Run against a local worker: node test/api.test.mjs
// Admin password comes from ADMIN_PASSWORD (default: the local dev value).
import assert from 'node:assert/strict';
const API = process.env.API || 'http://localhost:8787';
const PASS = process.env.ADMIN_PASSWORD || 'local-test-password';
let passed = 0;
const rid = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('') + 'abcd';
async function call(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8801', 'CF-Connecting-IP': `10.${Math.floor(Math.random()*250)}.${Math.floor(Math.random()*250)}.${Math.floor(Math.random()*250)}`, ...(opts.headers || {}) } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
}
const post = (p, b, h) => call(p, { method: 'POST', body: JSON.stringify(b), headers: h });
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
}
const good = (over = {}) => ({ idem: rid(), name: 'Test Buyer', phone: '0300 1234567', city: 'Lahore', address: 'House 1, Street 2, Gulberg', notes: '[TEST]', items: [{ colour: 'obsidian', qty: 1 }], ...over });

let token;
await test('config loads with price and colours', async () => {
  const r = await call('/api/config');
  assert.equal(r.status, 200);
  assert.ok(r.body.product.price > 0);
  assert.ok(r.body.colours.length >= 1);
});
await test('CORS allows localhost and blocks unknown origins', async () => {
  const a = await call('/api/config');
  assert.equal(a.headers.get('access-control-allow-origin'), 'http://localhost:8801');
  const b = await call('/api/config', { headers: { Origin: 'https://evil.example' } });
  assert.equal(b.headers.get('access-control-allow-origin'), null);
});
await test('admin endpoints reject no token and bad token', async () => {
  assert.equal((await call('/api/admin/orders')).status, 401);
  assert.equal((await call('/api/admin/orders', { headers: { Authorization: 'Bearer abc.def' } })).status, 401);
});
await test('wrong password is rejected, right password gives a token', async () => {
  assert.equal((await post('/api/admin/login', { password: 'nope' })).status, 401);
  const r = await post('/api/admin/login', { password: PASS });
  assert.equal(r.status, 200);
  token = r.body.token;
  assert.ok(token.includes('.'));
});
const A = () => ({ Authorization: 'Bearer ' + token });

await test('order validation returns field errors', async () => {
  const r = await post('/api/orders', good({ name: 'A', phone: '12345', city: '', address: 'x' }));
  assert.equal(r.status, 422);
  for (const f of ['name', 'phone', 'city', 'address']) assert.ok(r.body.error.fields[f], f);
});
await test('empty cart and unknown colour are rejected', async () => {
  assert.equal((await post('/api/orders', good({ items: [] }))).status, 422);
  assert.equal((await post('/api/orders', good({ items: [{ colour: 'nope', qty: 1 }] }))).status, 409);
});
await test('bad idempotency key is rejected', async () => {
  assert.equal((await post('/api/orders', good({ idem: 'short' }))).status, 400);
});

let first;
const stockOf = async () => (await call('/api/admin/settings', { headers: A() })).body.colours.find((c) => c.id === 'obsidian').stock;
const s0 = await stockOf();
await test('valid order is created, totals computed on the server', async () => {
  const r = await post('/api/orders', good({ items: [{ colour: 'obsidian', qty: 2 }], expect_total: 11000 }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  first = { ...r.body.order };
  assert.match(first.number, /^AV-\d+$/);
  assert.equal(first.total, 11000);
  assert.equal(await stockOf(), s0 - 2);
});
await test('same idempotency key never creates a second order or takes stock twice', async () => {
  const body = good();
  const a = await post('/api/orders', body);
  const b = await post('/api/orders', body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(a.body.order.number, b.body.order.number);
});
await test('ten parallel requests with one key make exactly one order', async () => {
  const body = good();
  const before = await stockOf();
  const rs = await Promise.all(Array.from({ length: 10 }, () => post('/api/orders', body)));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201), rs.map((r) => r.status).join());
  assert.equal(new Set(rs.map((r) => r.body.order.number)).size, 1);
  assert.equal(await stockOf(), before - 1);
});
await test('client total that disagrees with the server is refused with fresh config', async () => {
  const r = await post('/api/orders', good({ expect_total: 1 }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'price_changed');
  assert.ok(r.body.error.config.product.price > 0);
});
await test('honeypot field is silently ignored', async () => {
  const before = await stockOf();
  const r = await post('/api/orders', good({ website: 'http://spam' }));
  assert.equal(r.body.ignored, true);
  assert.equal(await stockOf(), before);
});
await test('overselling is impossible (parallel orders against limited stock)', async () => {
  const cfg = (await call('/api/admin/settings', { headers: A() })).body;
  const keep = cfg.colours.map((c) => ({ ...c }));
  const limited = keep.map((c) => (c.id === 'obsidian' ? { ...c, stock: 3 } : c));
  await call('/api/admin/settings', { method: 'PUT', headers: A(), body: JSON.stringify({ settings: cfg.settings, colours: limited }) });
  const rs = await Promise.all(Array.from({ length: 8 }, () => post('/api/orders', good())));
  const made = rs.filter((r) => r.status === 201).length;
  const refused = rs.filter((r) => r.status === 409 && r.body.error.code === 'out_of_stock').length;
  assert.equal(made, 3, `made ${made}`);
  assert.equal(refused, 5);
  assert.equal(await stockOf(), 0);
  const sold = (await call('/api/config')).body.colours[0];
  assert.equal(sold.available, false);
  assert.equal(sold.sold_out, true);
  await call('/api/admin/settings', { method: 'PUT', headers: A(), body: JSON.stringify({ settings: cfg.settings, colours: keep.map((c) => ({ ...c, stock: s0 })) }) });
});

await test('tracking needs the right phone and hides the address', async () => {
  const ok = await call(`/api/track?number=${first.number}&phone=03001234567`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.order.status, 'new');
  assert.ok(!JSON.stringify(ok.body).includes('Gulberg'));
  assert.equal((await call(`/api/track?number=${first.number}&phone=03009999999`)).status, 404);
  const lower = await call(`/api/track?number=${first.number.toLowerCase()}&phone=%2B92300%201234567`);
  assert.equal(lower.status, 200);
});

let oid;
await test('admin lists, searches and opens orders', async () => {
  const l = await call('/api/admin/orders?status=new&q=Gulberg', { headers: A() });
  assert.equal(l.status, 200);
  assert.ok(l.body.orders.length >= 1);
  const row = l.body.orders.find((o) => o.number === first.number);
  assert.ok(row && row.items.length === 1);
  assert.equal(row.idem_key, undefined);
  oid = row.id;
  const d = await call('/api/admin/orders/' + oid, { headers: A() });
  assert.equal(d.body.order.events[0].kind, 'placed');
  const s = await call('/api/admin/summary', { headers: A() });
  assert.ok(s.body.counts.new >= 1);
  assert.ok(s.body.today.orders >= 1);
});
await test('status moves through the flow and the customer sees it', async () => {
  for (const st of ['confirmed', 'packed']) assert.equal((await call('/api/admin/orders/' + oid, { method: 'PATCH', headers: A(), body: JSON.stringify({ status: st }) })).status, 200);
  const sh = await call('/api/admin/orders/' + oid, { method: 'PATCH', headers: A(), body: JSON.stringify({ status: 'shipped', courier: 'NovaX', tracking: 'NX123' }) });
  assert.equal(sh.body.order.courier, 'NovaX');
  const t = await call(`/api/track?number=${first.number}&phone=03001234567`);
  assert.equal(t.body.order.status, 'shipped');
  assert.equal(t.body.order.tracking, 'NX123');
  assert.deepEqual(t.body.order.events.map((e) => e.kind), ['placed', 'confirmed', 'packed', 'shipped']);
});
await test('delivered marks cash collected; invalid status is refused', async () => {
  const d = await call('/api/admin/orders/' + oid, { method: 'PATCH', headers: A(), body: JSON.stringify({ status: 'delivered' }) });
  assert.equal(d.body.order.pay_status, 'paid');
  assert.equal((await call('/api/admin/orders/' + oid, { method: 'PATCH', headers: A(), body: JSON.stringify({ status: 'teleported' }) })).status, 422);
});
await test('cancelling restocks, reopening takes stock again, no double restock', async () => {
  const r = await post('/api/orders', good({ items: [{ colour: 'obsidian', qty: 3 }] }));
  const id = (await call('/api/admin/orders?q=' + r.body.order.number, { headers: A() })).body.orders[0].id;
  const before = await stockOf();
  await call('/api/admin/orders/' + id, { method: 'PATCH', headers: A(), body: JSON.stringify({ status: 'cancelled' }) });
  assert.equal(await stockOf(), before + 3);
  await call('/api/admin/orders/' + id, { method: 'PATCH', headers: A(), body: JSON.stringify({ status: 'cancelled' }) });
  assert.equal(await stockOf(), before + 3);
  await call('/api/admin/orders/' + id, { method: 'PATCH', headers: A(), body: JSON.stringify({ status: 'confirmed' }) });
  assert.equal(await stockOf(), before);
});
await test('settings: price change flows to config; bad values refused', async () => {
  const cfg = (await call('/api/admin/settings', { headers: A() })).body;
  const bad = await call('/api/admin/settings', { method: 'PUT', headers: A(), body: JSON.stringify({ settings: { ...cfg.settings, price: 5 }, colours: cfg.colours }) });
  assert.equal(bad.status, 422);
  await call('/api/admin/settings', { method: 'PUT', headers: A(), body: JSON.stringify({ settings: { ...cfg.settings, price: 5900 }, colours: cfg.colours }) });
  assert.equal((await call('/api/config')).body.product.price, 5900);
  await call('/api/admin/settings', { method: 'PUT', headers: A(), body: JSON.stringify({ settings: cfg.settings, colours: cfg.colours }) });
  assert.equal((await call('/api/config')).body.product.price, cfg.settings.price);
});
await test('csv export escapes formulas and quotes', async () => {
  await post('/api/orders', good({ name: '=cmd|calc', address: 'Flat "9", Block B, DHA' }));
  const r = await call('/api/admin/export?status=all', { headers: A() });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes("\"'=cmd|calc\""));
  assert.ok(r.body.includes('Flat ""9""'));
});
await test('messages and waitlist are saved and visible to admin', async () => {
  assert.equal((await post('/api/messages', { kind: 'waitlist', contact: 'a@b.co' })).status, 201);
  assert.equal((await post('/api/messages', { kind: 'contact', contact: 'x' , body: ''})).status, 422);
  const m = await call('/api/admin/messages', { headers: A() });
  assert.ok(m.body.messages.some((x) => x.kind === 'waitlist' && x.contact === 'a@b.co'));
});
await test('one connection is rate limited after 30 orders in 10 minutes', async () => {
  const ip = { 'CF-Connecting-IP': '203.0.113.77' };
  const cfg = (await call('/api/admin/settings', { headers: A() })).body;
  await call('/api/admin/settings', { method: 'PUT', headers: A(), body: JSON.stringify({ settings: cfg.settings, colours: cfg.colours.map((c) => ({ ...c, stock: 500 })) }) });
  let limited = 0;
  for (let i = 0; i < 32; i++) { const r = await post('/api/orders', good(), ip); if (r.status === 429) limited++; }
  assert.ok(limited >= 2, 'limited ' + limited);
  await call('/api/admin/settings', { method: 'PUT', headers: A(), body: JSON.stringify({ settings: cfg.settings, colours: cfg.colours }) });
});
await test('unknown routes 404 as JSON', async () => {
  const r = await call('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
});
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
