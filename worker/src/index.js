// Aarve store API. Cloudflare Worker + D1.
// Public: config, orders, track, messages. Admin: everything under /api/admin (Bearer token).

const STATUSES = ['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'];
const OPEN = ['new', 'confirmed', 'packed', 'shipped'];
const DEAD = ['cancelled', 'returned'];
const PUBLIC_KINDS = new Set(['placed', ...STATUSES]);
const enc = new TextEncoder();

const iso = () => new Date().toISOString();
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMulti = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  const h = { Vary: 'Origin' };
  if (ok) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, PUT, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function reply(req, env, data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(req, env), ...extraHeaders },
  });
}

async function readJson(req, limit = 24000) {
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, 'too_large', 'Request is too large.');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'bad_json', 'Request was not valid JSON.'); }
}

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ---------- rate limiting ----------
async function hit(env, bucket, windowSec, max, count = true) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate WHERE bucket=?1 AND at>?2').bind(bucket, now - windowSec).first();
  if ((row?.n || 0) >= max) return false;
  if (count) await env.DB.prepare('INSERT INTO rate(bucket,at) VALUES(?1,?2)').bind(bucket, now).run();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM rate WHERE at<?1').bind(now - 86400).run();
  return true;
}
const ipOf = (req) => req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'local';

// ---------- validation ----------
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0092')) d = '0' + d.slice(4);
  else if (d.startsWith('92') && d.length === 12) d = '0' + d.slice(2);
  else if (d.length === 10 && d.startsWith('3')) d = '0' + d;
  return /^03\d{9}$/.test(d) ? d : null;
}

// ---------- settings ----------
async function loadSettings(env) {
  const { results } = await env.DB.prepare('SELECT key,value FROM settings').all();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return {
    product_name: s.product_name || 'AARVE MAG/01 Magnetic Pull-Lift Wallet',
    price: parseInt(s.price, 10) || 0,
    shipping_fee: parseInt(s.shipping_fee, 10) || 0,
    announcement: s.announcement || '',
    delivery_text: s.delivery_text || '',
    max_qty: Math.max(1, Math.min(10, parseInt(s.max_qty, 10) || 5)),
  };
}
async function loadColours(env) {
  const { results } = await env.DB.prepare('SELECT id,name,hex,stock,available,sort FROM colours ORDER BY sort,id').all();
  return results;
}
function publicConfig(settings, colours) {
  return {
    product: settings,
    colours: colours.map((c) => ({
      id: c.id, name: c.name, hex: c.hex, available: !!c.available && c.stock > 0,
      sold_out: !!c.available && c.stock <= 0, stock: c.stock <= 10 ? c.stock : null,
    })),
    countries: ['PK'],
  };
}

// ---------- orders ----------
async function itemsFor(env, ids) {
  if (!ids.length) return {};
  const q = ids.map((_, i) => '?' + (i + 1)).join(',');
  const { results } = await env.DB.prepare(`SELECT order_id,colour_id,colour_name,qty,unit_price FROM order_items WHERE order_id IN (${q}) ORDER BY id`).bind(...ids).all();
  const out = {};
  for (const r of results) (out[r.order_id] ||= []).push({ colour_id: r.colour_id, colour: r.colour_name, qty: r.qty, unit_price: r.unit_price });
  return out;
}

async function restock(env, items) {
  for (const it of items) await env.DB.prepare('UPDATE colours SET stock=stock+?1 WHERE id=?2').bind(it.qty, it.colour_id).run();
}

async function createOrder(req, env) {
  const b = await readJson(req);
  if (b.website) return { ok: true, order: { number: 'AV-0000', status: 'new', total: 0, items: [], created_at: iso() }, ignored: true };

  const idem = String(b.idem || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(idem)) throw new HttpError(400, 'bad_idem', 'Missing order key. Please reload and try again.');

  const prior = await env.DB.prepare('SELECT id FROM orders WHERE idem_key=?1').bind(idem).first();
  if (prior) return { ok: true, duplicate: true, order: await publicOrder(env, prior.id) };

  const errors = {};
  const name = clean(b.name, 80);
  const phone = normPhone(b.phone);
  const city = clean(b.city, 60);
  const address = clean(b.address, 300);
  const notes = clean(b.notes, 300);
  if (name.length < 2) errors.name = 'Enter your full name.';
  if (!phone) errors.phone = 'Enter a Pakistani mobile number like 03XX XXXXXXX.';
  if (city.length < 2) errors.city = 'Enter your city.';
  if (address.length < 8) errors.address = 'Enter your full address, including area and house number.';
  const rawItems = Array.isArray(b.items) ? b.items.slice(0, 10) : [];
  const agg = new Map();
  for (const it of rawItems) {
    const id = clean(it?.colour, 40);
    const qty = parseInt(it?.qty, 10);
    if (!id || !(qty >= 1 && qty <= 20)) continue;
    agg.set(id, (agg.get(id) || 0) + qty);
  }
  if (!agg.size) errors.items = 'Your cart is empty.';
  if (Object.keys(errors).length) throw new HttpError(422, 'invalid', 'Please check the highlighted fields.', { fields: errors });

  if (!(await hit(env, 'o:' + (await sha(ipOf(req))), 600, 30))) throw new HttpError(429, 'rate_limited', 'Too many orders from this connection. Please wait a few minutes.');

  const settings = await loadSettings(env);
  const colours = await loadColours(env);
  const byId = new Map(colours.map((c) => [c.id, c]));
  let qtyTotal = 0;
  const lines = [];
  for (const [id, qty] of agg) {
    const c = byId.get(id);
    if (!c || !c.available) throw new HttpError(409, 'unavailable', 'That colour is not available.', { config: publicConfig(settings, colours) });
    qtyTotal += qty;
    lines.push({ colour_id: id, colour_name: c.name, qty, unit_price: settings.price });
  }
  if (qtyTotal > settings.max_qty) throw new HttpError(422, 'invalid', `You can order up to ${settings.max_qty} per order.`, { fields: { items: `You can order up to ${settings.max_qty} per order.` } });

  const subtotal = settings.price * qtyTotal;
  const shipping = settings.shipping_fee;
  const total = subtotal + shipping;
  if (b.expect_total != null && parseInt(b.expect_total, 10) !== total) {
    throw new HttpError(409, 'price_changed', 'The price has changed. Please review your total.', { config: publicConfig(settings, colours), total });
  }

  const done = [];
  for (const l of lines) {
    const r = await env.DB.prepare('UPDATE colours SET stock=stock-?1 WHERE id=?2 AND available=1 AND stock>=?1').bind(l.qty, l.colour_id).run();
    if (r.meta.changes !== 1) {
      await restock(env, done);
      const fresh = await loadColours(env);
      throw new HttpError(409, 'out_of_stock', 'Sorry, that is no longer in stock in the quantity you chose.', { config: publicConfig(settings, fresh) });
    }
    done.push(l);
  }

  const now = iso();
  try {
    const stmts = [
      env.DB.prepare(`INSERT INTO orders(idem_key,status,pay_status,name,phone,city,address,notes,country,subtotal,shipping,total,created_at,updated_at)
        VALUES(?1,'new','unpaid',?2,?3,?4,?5,?6,'PK',?7,?8,?9,?10,?10)`).bind(idem, name, phone, city, address, notes, subtotal, shipping, total, now),
      env.DB.prepare(`UPDATE orders SET number='AV-'||(1000+id) WHERE idem_key=?1`).bind(idem),
      ...lines.map((l) => env.DB.prepare(`INSERT INTO order_items(order_id,colour_id,colour_name,qty,unit_price) SELECT id,?2,?3,?4,?5 FROM orders WHERE idem_key=?1`).bind(idem, l.colour_id, l.colour_name, l.qty, l.unit_price)),
      env.DB.prepare(`INSERT INTO order_events(order_id,at,kind,detail) SELECT id,?2,'placed','' FROM orders WHERE idem_key=?1`).bind(idem, now),
    ];
    await env.DB.batch(stmts);
  } catch (e) {
    await restock(env, done);
    const again = await env.DB.prepare('SELECT id FROM orders WHERE idem_key=?1').bind(idem).first();
    if (again) {
      // a parallel request with the same key won: its stock was taken, ours is returned above
      return { ok: true, duplicate: true, order: await publicOrder(env, again.id) };
    }
    throw e;
  }
  const row = await env.DB.prepare('SELECT id FROM orders WHERE idem_key=?1').bind(idem).first();
  return { ok: true, order: await publicOrder(env, row.id) };
}

async function publicOrder(env, id) {
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(id).first();
  if (!o) return null;
  const items = (await itemsFor(env, [id]))[id] || [];
  return { number: o.number, status: o.status, subtotal: o.subtotal, shipping: o.shipping, total: o.total, created_at: o.created_at, city: o.city, items };
}

async function track(req, env) {
  const url = new URL(req.url);
  const number = clean(url.searchParams.get('number'), 20).toUpperCase().replace(/^AV\s*-?\s*/, 'AV-');
  const phone = normPhone(url.searchParams.get('phone'));
  if (!(await hit(env, 't:' + (await sha(ipOf(req))), 600, 30))) throw new HttpError(429, 'rate_limited', 'Too many lookups. Please wait a few minutes.');
  if (!number || !phone) throw new HttpError(422, 'invalid', 'Enter your order number and the phone number you ordered with.');
  const o = await env.DB.prepare('SELECT * FROM orders WHERE number=?1 AND phone=?2').bind(number, phone).first();
  if (!o) throw new HttpError(404, 'not_found', 'We could not find that order. Check the number and phone.');
  const { results } = await env.DB.prepare('SELECT at,kind FROM order_events WHERE order_id=?1 ORDER BY id').bind(o.id).all();
  const items = (await itemsFor(env, [o.id]))[o.id] || [];
  return {
    ok: true,
    order: {
      number: o.number, status: o.status, total: o.total, created_at: o.created_at, items,
      courier: o.courier, tracking: o.tracking, pay_status: o.pay_status,
      events: results.filter((e) => PUBLIC_KINDS.has(e.kind)),
    },
  };
}

async function postMessage(req, env) {
  const b = await readJson(req);
  if (b.website) return { ok: true };
  const kind = b.kind === 'waitlist' ? 'waitlist' : 'contact';
  const contact = clean(b.contact, 120);
  const name = clean(b.name, 80);
  const body = cleanMulti(b.body, 1000);
  const fields = {};
  if (contact.length < 5) fields.contact = 'Enter an email or phone number so we can reach you.';
  if (kind === 'contact' && body.length < 3) fields.body = 'Write your message.';
  if (Object.keys(fields).length) throw new HttpError(422, 'invalid', 'Please check the highlighted fields.', { fields });
  if (!(await hit(env, 'm:' + (await sha(ipOf(req))), 600, 8))) throw new HttpError(429, 'rate_limited', 'Too many messages. Please wait a few minutes.');
  await env.DB.prepare('INSERT INTO messages(kind,name,contact,body,created_at) VALUES(?1,?2,?3,?4,?5)').bind(kind, name, contact, body, iso()).run();
  return { ok: true };
}

// ---------- admin ----------
async function login(req, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) throw new HttpError(503, 'not_configured', 'Admin is not configured.');
  const bucket = 'l:' + (await sha(ipOf(req)));
  if (!(await hit(env, bucket, 900, 8, false))) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in 15 minutes.');
  const b = await readJson(req, 2000);
  const given = await hmac(env.SESSION_SECRET, String(b.password || ''));
  const real = await hmac(env.SESSION_SECRET, env.ADMIN_PASSWORD);
  if (!safeEqual(given, real)) {
    await hit(env, bucket, 900, 9999, true);
    throw new HttpError(401, 'bad_login', 'Wrong password.');
  }
  const payload = b64u(enc.encode(JSON.stringify({ exp: Date.now() + 12 * 3600 * 1000 })));
  const sig = b64u(await hmac(env.SESSION_SECRET, payload));
  return { ok: true, token: `${payload}.${sig}`, expires_in: 12 * 3600 };
}

async function requireAdmin(req, env) {
  const h = req.headers.get('Authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [payload, sig] = tok.split('.');
  if (!payload || !sig || !env.SESSION_SECRET) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  try {
    const want = await hmac(env.SESSION_SECRET, payload);
    if (!safeEqual(want, fromB64u(sig))) throw 0;
    const data = JSON.parse(new TextDecoder().decode(fromB64u(payload)));
    if (!(data.exp > Date.now())) throw 0;
  } catch {
    throw new HttpError(401, 'unauthorized', 'Please sign in again.');
  }
}

const pkDayStartIso = () => {
  const pk = new Date(Date.now() + 5 * 3600 * 1000);
  pk.setUTCHours(0, 0, 0, 0);
  return new Date(pk.getTime() - 5 * 3600 * 1000).toISOString();
};

async function adminSummary(env) {
  const { results: counts } = await env.DB.prepare('SELECT status,COUNT(*) AS n FROM orders GROUP BY status').all();
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const c of counts) byStatus[c.status] = c.n;
  const start = pkDayStartIso();
  const today = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','returned') THEN total END),0) AS rev FROM orders WHERE created_at>=?1`).bind(start).first();
  const delivered = await env.DB.prepare(`SELECT COALESCE(SUM(total),0) AS rev FROM orders WHERE status='delivered'`).first();
  const pipeline = await env.DB.prepare(`SELECT COALESCE(SUM(total),0) AS rev FROM orders WHERE status IN ('new','confirmed','packed','shipped')`).first();
  const unread = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE handled=0').first();
  const colours = await loadColours(env);
  const latest = await env.DB.prepare('SELECT COALESCE(MAX(id),0) AS id FROM orders').first();
  return { ok: true, counts: byStatus, today: { orders: today.n, revenue: today.rev }, delivered_revenue: delivered.rev, pipeline_revenue: pipeline.rev, unread_messages: unread.n, colours, latest_order_id: latest.id };
}

async function adminOrders(req, env) {
  const u = new URL(req.url);
  const status = u.searchParams.get('status') || 'open';
  const q = clean(u.searchParams.get('q'), 60);
  const before = parseInt(u.searchParams.get('before'), 10) || 0;
  const limit = Math.min(100, parseInt(u.searchParams.get('limit'), 10) || 40);
  const where = [];
  const args = [];
  if (status === 'open') where.push(`status IN ('new','confirmed','packed','shipped')`);
  else if (STATUSES.includes(status)) { where.push(`status=?${args.length + 1}`); args.push(status); }
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const n = args.length + 1;
    where.push(`(number LIKE ?${n} OR name LIKE ?${n} OR phone LIKE ?${n} OR city LIKE ?${n} OR address LIKE ?${n} OR tracking LIKE ?${n})`);
    args.push(like);
  }
  if (before) { where.push(`id<?${args.length + 1}`); args.push(before); }
  const sql = `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit + 1}`;
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  const more = results.length > limit;
  const rows = results.slice(0, limit);
  const items = await itemsFor(env, rows.map((r) => r.id));
  return { ok: true, orders: rows.map((r) => ({ ...r, idem_key: undefined, items: items[r.id] || [] })), more };
}

async function adminOrder(env, id) {
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(id).first();
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  const items = (await itemsFor(env, [id]))[id] || [];
  const { results: events } = await env.DB.prepare('SELECT at,kind,detail FROM order_events WHERE order_id=?1 ORDER BY id').bind(id).all();
  return { ok: true, order: { ...o, idem_key: undefined, items, events } };
}

async function adminPatchOrder(req, env, id) {
  const b = await readJson(req, 4000);
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(id).first();
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  const items = (await itemsFor(env, [id]))[id] || [];
  const now = iso();
  const sets = [];
  const args = [];
  const events = [];
  const put = (col, val) => { args.push(val); sets.push(`${col}=?${args.length}`); };

  let status = o.status;
  let pay = o.pay_status;
  if (b.status !== undefined && b.status !== o.status) {
    if (!STATUSES.includes(b.status)) throw new HttpError(422, 'invalid', 'Unknown status.');
    const wasDead = DEAD.includes(o.status);
    const willDie = DEAD.includes(b.status);
    if (!wasDead && willDie) await restock(env, items);
    if (wasDead && !willDie) {
      const taken = [];
      for (const it of items) {
        const r = await env.DB.prepare('UPDATE colours SET stock=stock-?1 WHERE id=?2 AND stock>=?1').bind(it.qty, it.colour_id).run();
        if (r.meta.changes !== 1) {
          await restock(env, taken);
          throw new HttpError(409, 'out_of_stock', 'Not enough stock to reopen this order. Add stock first.');
        }
        taken.push(it);
      }
    }
    status = b.status;
    put('status', status);
    events.push([status, '']);
    if (status === 'delivered' && pay === 'unpaid') { pay = 'paid'; put('pay_status', pay); events.push(['payment', 'Cash collected on delivery']); }
  }
  if (b.pay_status !== undefined && b.pay_status !== pay) {
    if (!['unpaid', 'paid'].includes(b.pay_status)) throw new HttpError(422, 'invalid', 'Unknown payment status.');
    put('pay_status', b.pay_status);
    events.push(['payment', b.pay_status === 'paid' ? 'Marked paid' : 'Marked unpaid']);
  }
  for (const [key, max] of [['courier', 60], ['tracking', 80]]) {
    if (b[key] !== undefined) {
      const v = clean(b[key], max);
      if (v !== o[key]) { put(key, v); events.push(['update', `${key} set to ${v || 'empty'}`]); }
    }
  }
  if (b.admin_note !== undefined) {
    const v = cleanMulti(b.admin_note, 600);
    if (v !== o.admin_note) { put('admin_note', v); events.push(['note', v]); }
  }
  if (!sets.length) return { ok: true, ...(await adminOrder(env, id)) };
  put('updated_at', now);
  args.push(id);
  const stmts = [env.DB.prepare(`UPDATE orders SET ${sets.join(',')} WHERE id=?${args.length}`).bind(...args)];
  for (const [kind, detail] of events) stmts.push(env.DB.prepare('INSERT INTO order_events(order_id,at,kind,detail) VALUES(?1,?2,?3,?4)').bind(id, now, kind, detail));
  await env.DB.batch(stmts);
  return { ok: true, ...(await adminOrder(env, id)) };
}

async function adminGetSettings(env) {
  return { ok: true, settings: await loadSettings(env), colours: await loadColours(env) };
}

async function adminPutSettings(req, env) {
  const b = await readJson(req, 8000);
  const s = b.settings || {};
  const fields = {};
  const price = parseInt(s.price, 10);
  const ship = parseInt(s.shipping_fee, 10);
  const maxq = parseInt(s.max_qty, 10);
  if (!(price >= 100 && price <= 500000)) fields.price = 'Price must be between 100 and 500,000.';
  if (!(ship >= 0 && ship <= 20000)) fields.shipping_fee = 'Delivery fee must be between 0 and 20,000.';
  if (!(maxq >= 1 && maxq <= 10)) fields.max_qty = 'Max per order must be 1 to 10.';
  const name = clean(s.product_name, 80);
  if (name.length < 2) fields.product_name = 'Enter a product name.';
  const cols = Array.isArray(b.colours) ? b.colours.slice(0, 12) : [];
  const norm = [];
  cols.forEach((c, i) => {
    const nm = clean(c.name, 30);
    const hex = /^#[0-9a-fA-F]{6}$/.test(c.hex || '') ? c.hex : null;
    const stock = parseInt(c.stock, 10);
    const id = clean(c.id, 40) || nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!nm || !hex || !(stock >= 0 && stock <= 100000) || !id) fields[`colour_${i}`] = 'Each colour needs a name, a #RRGGBB colour and a stock number.';
    else norm.push({ id, name: nm, hex, stock, available: c.available ? 1 : 0, sort: i });
  });
  if (!norm.length && !fields.colours) fields.colours = 'Keep at least one colour.';
  if (Object.keys(fields).length) throw new HttpError(422, 'invalid', 'Please fix the highlighted fields.', { fields });
  const stmts = [
    ['product_name', name], ['price', String(price)], ['shipping_fee', String(ship)], ['max_qty', String(maxq)],
    ['announcement', clean(s.announcement, 140)], ['delivery_text', clean(s.delivery_text, 80)],
  ].map(([k, v]) => env.DB.prepare('INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2').bind(k, v));
  for (const c of norm) {
    stmts.push(env.DB.prepare(`INSERT INTO colours(id,name,hex,stock,available,sort) VALUES(?1,?2,?3,?4,?5,?6)
      ON CONFLICT(id) DO UPDATE SET name=?2,hex=?3,stock=?4,available=?5,sort=?6`).bind(c.id, c.name, c.hex, c.stock, c.available, c.sort));
  }
  await env.DB.batch(stmts);
  return adminGetSettings(env);
}

async function adminMessages(env) {
  const { results } = await env.DB.prepare('SELECT * FROM messages ORDER BY handled, id DESC LIMIT 200').all();
  return { ok: true, messages: results };
}
async function adminPatchMessage(req, env, id) {
  const b = await readJson(req, 500);
  await env.DB.prepare('UPDATE messages SET handled=?1 WHERE id=?2').bind(b.handled ? 1 : 0, id).run();
  return { ok: true };
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};
async function adminExport(req, env) {
  const u = new URL(req.url);
  const status = u.searchParams.get('status') || 'all';
  const where = status === 'open' ? `WHERE status IN ('new','confirmed','packed','shipped')` : STATUSES.includes(status) ? `WHERE status='${status}'` : '';
  const { results } = await env.DB.prepare(`SELECT * FROM orders ${where} ORDER BY id DESC LIMIT 5000`).all();
  const items = await itemsFor(env, results.map((r) => r.id));
  const head = ['Order', 'Placed (PKT)', 'Status', 'Payment', 'Name', 'Phone', 'City', 'Address', 'Items', 'Total (PKR)', 'Courier', 'Tracking', 'Customer notes', 'Internal note'];
  const pkt = (t) => new Date(new Date(t).getTime() + 5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const rows = results.map((r) => [
    r.number, pkt(r.created_at), r.status, r.pay_status, r.name, r.phone, r.city, r.address,
    (items[r.id] || []).map((i) => `${i.qty} x ${i.colour}`).join('; '), r.total, r.courier, r.tracking, r.notes, r.admin_note,
  ]);
  const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="aarve-orders.csv"', 'Cache-Control': 'no-store', ...corsHeaders(req, env) },
  });
}

// ---------- router ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    try {
      if (path === '/api/health') return reply(req, env, { ok: true, time: iso() });
      if (path === '/api/config' && req.method === 'GET') {
        const [s, c] = await Promise.all([loadSettings(env), loadColours(env)]);
        return reply(req, env, { ok: true, ...publicConfig(s, c) }, 200, { 'Cache-Control': 'public, max-age=5' });
      }
      if (path === '/api/orders' && req.method === 'POST') {
        const r = await createOrder(req, env);
        return reply(req, env, r, r.duplicate ? 200 : 201);
      }
      if (path === '/api/track' && req.method === 'GET') return reply(req, env, await track(req, env));
      if (path === '/api/messages' && req.method === 'POST') return reply(req, env, await postMessage(req, env), 201);
      if (path === '/api/admin/login' && req.method === 'POST') return reply(req, env, await login(req, env));

      if (path.startsWith('/api/admin/')) {
        await requireAdmin(req, env);
        let m;
        if (path === '/api/admin/summary') return reply(req, env, await adminSummary(env));
        if (path === '/api/admin/orders' && req.method === 'GET') return reply(req, env, await adminOrders(req, env));
        if (path === '/api/admin/export') return adminExport(req, env);
        if ((m = path.match(/^\/api\/admin\/orders\/(\d+)$/))) {
          if (req.method === 'GET') return reply(req, env, await adminOrder(env, +m[1]));
          if (req.method === 'PATCH') return reply(req, env, await adminPatchOrder(req, env, +m[1]));
        }
        if (path === '/api/admin/settings') {
          if (req.method === 'GET') return reply(req, env, await adminGetSettings(env));
          if (req.method === 'PUT') return reply(req, env, await adminPutSettings(req, env));
        }
        if (path === '/api/admin/messages' && req.method === 'GET') return reply(req, env, await adminMessages(env));
        if ((m = path.match(/^\/api\/admin\/messages\/(\d+)$/)) && req.method === 'PATCH') return reply(req, env, await adminPatchMessage(req, env, +m[1]));
      }
      return reply(req, env, { ok: false, error: { code: 'not_found', message: 'Not found.' } }, 404);
    } catch (e) {
      if (e instanceof HttpError) return reply(req, env, { ok: false, error: { code: e.code, message: e.message, ...(e.extra || {}) } }, e.status);
      console.error('aarve-api error', e && e.stack ? e.stack : e);
      return reply(req, env, { ok: false, error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } }, 500);
    }
  },
};
