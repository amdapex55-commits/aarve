/* AARVE MAG/01 storefront. Vanilla JS, no build step. */
(() => {
'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rs = (n) => 'Rs ' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduceMotion) document.documentElement.classList.add('rm');
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CFG = window.AARVE || {};
const API = (() => {
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const q = new URLSearchParams(location.search).get('api');
  return ((local ? (q || 'http://localhost:8787') : CFG.api || '')).replace(/\/$/, '');
})();

/* ---------- ads pixels (only load when an ID is set in config.js) ---------- */
function loadPixels() {
  const p = CFG.pixels || {};
  if (p.meta) {
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', p.meta); window.fbq('track', 'PageView');
  }
  if (p.tiktok) {
    !function (w, d, t) { w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || []; ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie']; ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; }; for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]); ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; }; ttq.load = function (e, n) { var i = 'https://analytics.tiktok.com/i18n/pixel/events.js'; ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = i; ttq._t = ttq._t || {}; ttq._t[e] = +new Date(); ttq._o = ttq._o || {}; ttq._o[e] = n || {}; var o = document.createElement('script'); o.type = 'text/javascript'; o.async = !0; o.src = i + '?sdkid=' + e + '&lib=' + t; var a = document.getElementsByTagName('script')[0]; a.parentNode.insertBefore(o, a); }; ttq.load(p.tiktok); ttq.page(); }(window, document, 'ttq');
  }
}
function track(ev, data = {}) {
  try {
    if (window.fbq) window.fbq('track', ev, data);
    if (window.ttq) window.ttq.track(({ ViewContent: 'ViewContent', AddToCart: 'AddToCart', InitiateCheckout: 'InitiateCheckout', Purchase: 'CompletePayment' })[ev] || ev, data);
  } catch {}
}

/* ---------- api ---------- */
class ApiError extends Error { constructor(status, err) { super(err.message || 'Request failed'); this.status = status; this.code = err.code; this.err = err; } }
class NetError extends Error { constructor(e) { super('Network'); this.cause = e; } }
async function api(path, { method = 'GET', body, timeout = 9000, retries = 0 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(API + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      clearTimeout(t);
      let data = null;
      try { data = await r.json(); } catch {}
      if (!r.ok) {
        const e = new ApiError(r.status, (data && data.error) || { message: 'Something went wrong. Please try again.' });
        if (r.status >= 500 && i < retries) { last = e; await sleep(600 * 2 ** i); continue; }
        throw e;
      }
      return data;
    } catch (e) {
      clearTimeout(t);
      if (e instanceof ApiError) throw e;
      last = new NetError(e);
      if (i < retries) await sleep(600 * 2 ** i);
    }
  }
  throw last;
}

/* ---------- state ---------- */
const store = {
  cfg: ls.get('aarve.cfg', null),
  state: 'loading',          // loading | ready | stale | error
  sel: ls.get('aarve.sel', null),
  cart: ls.get('aarve.cart', { lines: [] }),
};
const colours = () => (store.cfg ? store.cfg.colours : []);
const colourById = (id) => colours().find((c) => c.id === id);
const maxQty = () => (store.cfg ? store.cfg.product.max_qty : 5);
const price = () => (store.cfg ? store.cfg.product.price : 0);
const shipFee = () => (store.cfg ? store.cfg.product.shipping_fee : 0);
function saveCart() { ls.set('aarve.cart', store.cart); }
function totals() {
  const qty = store.cart.lines.reduce((a, l) => a + l.qty, 0);
  const sub = qty * price();
  const ship = qty ? shipFee() : 0;
  return { qty, sub, ship, total: sub + ship };
}

/* ---------- config ---------- */
async function loadConfig() {
  if (!store.cfg) store.state = 'loading'; else store.state = 'stale';
  renderBuy();
  try {
    const d = await api('/api/config', { retries: 2 });
    store.cfg = { product: d.product, colours: d.colours, countries: d.countries };
    ls.set('aarve.cfg', store.cfg);
    store.state = 'ready';
    pruneCart();
    if (!store.viewed) { store.viewed = true; track('ViewContent', { content_name: d.product.product_name, value: d.product.price, currency: 'PKR' }); }
  } catch (e) {
    store.state = store.cfg ? 'stale' : 'error';
  }
  renderBuy();
  renderCart();
}
function pruneCart() {
  const before = JSON.stringify(store.cart.lines);
  store.cart.lines = store.cart.lines.filter((l) => { const c = colourById(l.colour); return c && c.available; })
    .map((l) => { const c = colourById(l.colour); let q = clamp(l.qty, 1, maxQty()); if (c.stock != null) q = Math.min(q, Math.max(1, c.stock)); return { ...l, qty: q }; });
  if (JSON.stringify(store.cart.lines) !== before) saveCart();
}
function selected() {
  let c = colourById(store.sel);
  if (!c || !c.available) c = colours().find((x) => x.available) || colours()[0];
  if (c) store.sel = c.id;
  return c;
}

/* ---------- buy block ---------- */
function renderBuy() {
  const cfg = store.cfg;
  const priceEls = [$('#priceMain'), ...$$('[data-price]')];
  const shortEls = $$('[data-price-short]');
  const stockEls = [$('#stockNote'), ...$$('[data-stock]')];
  const addBtns = [$('#addBtn'), ...$$('[data-add]')];
  const nowBtns = [$('#buyNowBtn'), ...$$('[data-buynow]')];
  const err = $('#cfgError');
  if (!cfg) {
    const bad = store.state === 'error';
    priceEls.forEach((e) => { e.innerHTML = bad ? '<span class="muted">Price unavailable</span>' : `<span class="skel w-120 h-44${e.closest('.order') ? ' on-dark' : ''}"></span>`; });
    shortEls.forEach((e) => { e.textContent = ''; });
    stockEls.forEach((e) => { e.innerHTML = bad ? '' : '<span class="skel w-90 h-14"></span>'; });
    addBtns.concat(nowBtns).forEach((b) => { b.disabled = true; });
    err.hidden = !bad;
    return;
  }
  err.hidden = true;
  const c = selected();
  const p = cfg.product;
  priceEls.forEach((e) => { e.innerHTML = rs(p.price); });
  shortEls.forEach((e) => { e.textContent = rs(p.price); });
  const sold = !c || c.sold_out || !c.available;
  let note = '<span>In stock</span>';
  if (sold) note = '<span class="low">Sold out</span>';
  else if (c.stock != null) note = `<span class="low">Only ${c.stock} left</span>`;
  stockEls.forEach((e) => { e.innerHTML = note; });
  $$('.lbl', $('#addBtn')).forEach((l) => { l.textContent = sold ? 'Sold out' : 'Add to cart'; });
  addBtns.forEach((b) => { b.disabled = sold; const l = $('.lbl', b); if (l) l.textContent = sold ? 'Sold out' : 'Add to cart'; });
  nowBtns.forEach((b) => { b.disabled = sold; });
  $('#deliveryText').textContent = p.delivery_text || 'Delivered across Pakistan';
  const fd = $('#faqDelivery');
  if (fd) fd.textContent = `${p.delivery_text || 'Delivered across Pakistan'}. ${p.shipping_fee ? 'Delivery is ' + rs(p.shipping_fee) + '.' : 'Delivery is free.'}`;
  const an = $('#announce');
  an.hidden = !p.announcement; an.textContent = p.announcement || '';
  // swatches
  const sw = $('#swatches');
  const avail = cfg.colours.filter((x) => x.available || x.sold_out);
  if (avail.length > 1) {
    sw.hidden = false;
    sw.innerHTML = avail.map((x) => `<button type="button" class="swatch${x.available ? '' : ' soldout'}" role="radio" aria-checked="${x.id === store.sel}" aria-label="${esc(x.name)}${x.available ? '' : ', sold out'}" data-c="${esc(x.id)}" style="background:${esc(x.hex)}"></button>`).join('');
  } else sw.hidden = true;
}
$('#swatches').addEventListener('click', (e) => {
  const b = e.target.closest('.swatch'); if (!b) return;
  store.sel = b.dataset.c; ls.set('aarve.sel', store.sel); renderBuy();
});
$('#cfgRetry').addEventListener('click', () => loadConfig());

/* ---------- toasts ---------- */
function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
}

/* ---------- cart ---------- */
function addToCart(qty = 1) {
  const c = selected();
  if (!c || !c.available) { toast('That one is sold out.'); return false; }
  const line = store.cart.lines.find((l) => l.colour === c.id);
  const cap = c.stock != null ? Math.min(maxQty(), c.stock) : maxQty();
  if (line) {
    if (line.qty >= cap) { toast(`You can add up to ${cap}.`); return false; }
    line.qty = Math.min(cap, line.qty + qty);
  } else store.cart.lines.push({ colour: c.id, qty: Math.min(cap, qty) });
  saveCart();
  renderCart();
  const b = $('#cartCount'); b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump');
  track('AddToCart', { content_name: store.cfg.product.product_name, value: price(), currency: 'PKR' });
  return true;
}
function setQty(id, q) {
  const l = store.cart.lines.find((x) => x.colour === id); if (!l) return;
  const c = colourById(id);
  const cap = c && c.stock != null ? Math.min(maxQty(), c.stock) : maxQty();
  if (q <= 0) store.cart.lines = store.cart.lines.filter((x) => x !== l);
  else l.qty = clamp(q, 1, cap);
  saveCart(); renderCart();
}
function renderCart() {
  const t = totals();
  const cnt = $('#cartCount');
  cnt.textContent = t.qty; cnt.dataset.n = t.qty;
  const empty = !store.cart.lines.length;
  $('#cartEmpty').hidden = !empty;
  $('#cartLines').innerHTML = store.cart.lines.map((l) => {
    const c = colourById(l.colour) || { name: l.colour, hex: '#121110' };
    const cap = c.stock != null ? Math.min(maxQty(), c.stock) : maxQty();
    return `<li class="line" data-id="${esc(l.colour)}">
      <div class="pic"><img src="assets/img/thumb.jpg" alt="" width="72" height="96"></div>
      <div><h4>MAG/01</h4><div class="meta"><i style="background:${esc(c.hex)}"></i>${esc(c.name)}</div></div>
      <div class="lp">${rs(price() * l.qty)}</div>
      <div class="qty" role="group" aria-label="Quantity"><button type="button" data-q="-1" aria-label="One less">&minus;</button><span aria-live="polite">${l.qty}</span><button type="button" data-q="1" aria-label="One more"${l.qty >= cap ? ' disabled' : ''}>+</button></div>
      <button type="button" class="rm" data-rm>Remove</button></li>`;
  }).join('');
  $('#cartSub').textContent = rs(t.sub);
  $('#cartShipNote').textContent = empty ? '' : (t.ship ? `Delivery ${rs(t.ship)}. Pay on delivery.` : 'Free delivery. Pay on delivery.');
  $('#toCheckout').disabled = empty || !store.cfg;
  $('#cartFoot').hidden = empty || drawerView !== 'cart';
  if (drawerView === 'checkout') renderCheckoutSummary();
}
$('#cartLines').addEventListener('click', (e) => {
  const li = e.target.closest('.line'); if (!li) return;
  const id = li.dataset.id;
  const l = store.cart.lines.find((x) => x.colour === id); if (!l) return;
  const q = e.target.closest('[data-q]');
  if (q) setQty(id, l.qty + parseInt(q.dataset.q, 10));
  if (e.target.closest('[data-rm]')) setQty(id, 0);
});

/* ---------- overlays: drawer + modals, with back-button support ---------- */
let drawerView = 'cart';
let openOverlay = null;
let lastFocus = null;
const inertTargets = () => [$('#main'), $('header.top'), $('footer.foot'), $('#stickyBuy'), $('.skip')].filter(Boolean);
function lockPage(on) {
  document.body.classList.toggle('locked', on);
  inertTargets().forEach((el) => { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); });
}
function showOverlay(kind, el) {
  if (openOverlay) hideOverlay(true);
  lastFocus = document.activeElement;
  openOverlay = { kind, el };
  lockPage(true);
  el.removeAttribute('inert'); el.setAttribute('aria-hidden', 'false');
  if (kind === 'drawer') { const v = $('#veil'); v.hidden = false; requestAnimationFrame(() => { v.classList.add('show'); el.classList.add('open'); }); }
  else requestAnimationFrame(() => el.classList.add('open'));
  try { history.pushState({ ov: kind }, '', '#' + (kind === 'drawer' ? 'cart' : kind)); } catch {}
  setTimeout(() => { const f = el.querySelector('input:not([type=hidden]):not(.hp),button:not([disabled])'); if (f && !el.classList.contains('drawer')) f.focus({ preventScroll: true }); else el.querySelector('#drawerClose,[data-close]')?.focus({ preventScroll: true }); }, 60);
}
function hideOverlay(silent) {
  if (!openOverlay) return;
  const { kind, el } = openOverlay;
  openOverlay = null;
  el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); el.setAttribute('inert', '');
  if (kind === 'drawer') { const v = $('#veil'); v.classList.remove('show'); setTimeout(() => { if (!openOverlay) v.hidden = true; }, 360); }
  lockPage(false);
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  if (!silent && history.state && history.state.ov) history.back();
}
window.addEventListener('popstate', () => { if (openOverlay) hideOverlay(true); });
document.addEventListener('keydown', (e) => {
  if (!openOverlay) return;
  if (e.key === 'Escape') { hideOverlay(); return; }
  if (e.key === 'Tab') {
    const f = $$('button:not([disabled]):not([hidden]),input:not([disabled]):not(.hp),textarea,select,summary,a[href]', openOverlay.el).filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
$('#veil').addEventListener('click', () => hideOverlay());
$('#drawerClose').addEventListener('click', () => hideOverlay());
$$('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) hideOverlay(); });
});
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]'); if (!o) return;
  e.preventDefault();
  const k = o.dataset.open;
  if (k === 'track') openTrack(); if (k === 'contact') showOverlay('contact', $('#contactModal'));
});

function setView(v) {
  drawerView = v;
  $$('.view').forEach((s) => { s.hidden = s.dataset.view !== v; });
  $('#drawerBack').hidden = v !== 'checkout';
  $('#drawerTitle').textContent = v === 'cart' ? 'Your cart' : v === 'checkout' ? 'Checkout' : 'Thank you';
  $('#cartFoot').hidden = v !== 'cart' || !store.cart.lines.length;
  $('.dr-body').scrollTop = 0;
  if (v === 'checkout') { renderCheckoutSummary(); restoreDraft(); }
}
function openDrawer(v = 'cart') {
  setView(v);
  renderCart();
  if (!openOverlay || openOverlay.kind !== 'drawer') showOverlay('drawer', $('#drawer'));
}
$('#cartBtn').addEventListener('click', () => openDrawer('cart'));
$('#emptyShop').addEventListener('click', () => { hideOverlay(); location.hash = '#hero'; });
$('#drawerBack').addEventListener('click', () => setView('cart'));
$('#toCheckout').addEventListener('click', () => { if (!store.cart.lines.length) return; track('InitiateCheckout', { value: totals().total, currency: 'PKR' }); setView('checkout'); });
function addAndOpen() { if (addToCart(1)) openDrawer('cart'); }
$$('[data-add],#addBtn').forEach((b) => b.addEventListener('click', addAndOpen));
$$('[data-buynow],#buyNowBtn').forEach((b) => b.addEventListener('click', () => {
  if (!store.cart.lines.length && !addToCart(1)) return;
  track('InitiateCheckout', { value: totals().total, currency: 'PKR' });
  openDrawer('checkout');
}));

/* ---------- checkout ---------- */
const form = $('#checkoutForm');
function renderCheckoutSummary() {
  const t = totals();
  $('#coSum').innerHTML = store.cart.lines.map((l) => { const c = colourById(l.colour) || { name: l.colour }; return `<div class="r"><span>${l.qty} &times; MAG/01, ${esc(c.name)}</span><b>${rs(price() * l.qty)}</b></div>`; }).join('') || '<div class="r"><span>Your cart is empty.</span></div>';
  $('#coTotal').innerHTML = `<div class="r"><span>Subtotal</span><span>${rs(t.sub)}</span></div><div class="r"><span>Delivery</span><span>${t.ship ? rs(t.ship) : 'Free'}</span></div><div class="r big"><span>Total</span><span>${rs(t.total)}</span></div><div class="r"><span class="muted small">Pay the rider in cash on delivery</span></div>`;
  $('#placeBtn .lbl').textContent = `Place order · ${rs(t.total)}`;
  $('#placeBtn').disabled = !store.cart.lines.length;
}
function readForm() {
  const f = new FormData(form);
  return { name: String(f.get('name') || '').trim(), phone: String(f.get('phone') || '').trim(), city: String(f.get('city') || '').trim(), address: String(f.get('address') || '').trim(), notes: String(f.get('notes') || '').trim(), website: String(f.get('website') || '') };
}
function saveDraft() { const d = readForm(); delete d.website; ls.set('aarve.draft', d); }
function restoreDraft() {
  const d = ls.get('aarve.draft', null); if (!d) return;
  for (const k of ['name', 'phone', 'city', 'address', 'notes']) { const el = form.elements[k]; if (el && !el.value && d[k]) el.value = d[k]; }
}
form.addEventListener('input', (e) => { saveDraft(); const f = e.target.closest('.fld'); if (f) f.classList.remove('bad'); $('#coMsg').textContent = ''; });
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0092')) d = '0' + d.slice(4); else if (d.startsWith('92') && d.length === 12) d = '0' + d.slice(2); else if (d.length === 10 && d.startsWith('3')) d = '0' + d;
  return /^03\d{9}$/.test(d) ? d : null;
}
function validateOrder(d) {
  const e = {};
  if (d.name.replace(/\s+/g, ' ').length < 2) e.name = 'Enter your full name.';
  if (!normPhone(d.phone)) e.phone = 'Enter a Pakistani mobile number like 03XX XXXXXXX.';
  if (d.city.length < 2) e.city = 'Enter your city.';
  if (d.address.length < 8) e.address = 'Enter your full address, including area and house number.';
  return e;
}
function showErrors(root, errs) {
  $$('.fld', root).forEach((f) => { const k = f.dataset.f; const m = errs[k]; f.classList.toggle('bad', !!m); const el = $('.err', f); if (el) el.textContent = m || ''; });
  const first = Object.keys(errs)[0];
  if (first) { const el = $(`[name=${first}]`, root); if (el) el.focus({ preventScroll: false }); }
}
function setBusy(btn, on) { btn.classList.toggle('busy', on); btn.disabled = on; }

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('#coMsg'); msg.textContent = ''; msg.className = 'form-msg';
  if (!store.cart.lines.length) return;
  const d = readForm();
  const errs = validateOrder(d);
  showErrors(form, errs);
  if (Object.keys(errs).length) { msg.textContent = 'Please check the highlighted fields.'; msg.classList.add('bad'); return; }
  if (d.website) { onPlaced({ number: 'AV-0000', total: totals().total, items: [] }, d, false); return; }
  let idem = ls.get('aarve.idem', null);
  if (!idem) { idem = randomKey(); ls.set('aarve.idem', idem); }
  const payload = { idem, name: d.name, phone: d.phone, city: d.city, address: d.address, notes: d.notes, items: store.cart.lines.map((l) => ({ colour: l.colour, qty: l.qty })), expect_total: totals().total };
  const btn = $('#placeBtn');
  if (!navigator.onLine) { enqueue(payload); msg.textContent = 'You are offline. Your order is saved on this phone and will be sent automatically.'; msg.classList.add('good'); return; }
  setBusy(btn, true);
  try {
    const r = await api('/api/orders', { method: 'POST', body: payload, timeout: 12000 });
    onPlaced(r.order, d, false);
  } catch (e) {
    handleOrderError(e, payload, msg);
  } finally { setBusy(btn, false); renderCheckoutSummary(); }
});
function randomKey() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('') + Date.now().toString(36);
}
function handleOrderError(e, payload, msg) {
  msg.className = 'form-msg bad';
  if (e instanceof NetError || (e instanceof ApiError && e.status >= 500)) {
    enqueue(payload);
    msg.className = 'form-msg good';
    msg.textContent = 'We could not reach the shop just now. Your order is saved on this phone and will be sent automatically. Keep this page open.';
    return;
  }
  const er = e.err || {};
  if (e.status === 422 && er.fields) { showErrors(form, er.fields); msg.textContent = er.message || 'Please check the highlighted fields.'; if (er.fields.items) { msg.textContent = er.fields.items; } return; }
  if (er.config) { store.cfg = { product: er.config.product, colours: er.config.colours, countries: er.config.countries }; ls.set('aarve.cfg', store.cfg); pruneCart(); renderBuy(); renderCart(); renderCheckoutSummary(); }
  if (e.code === 'price_changed') { msg.textContent = 'The price has just changed. Please review your new total and place the order again.'; ls.del('aarve.idem'); return; }
  if (e.code === 'out_of_stock' || e.code === 'unavailable') { msg.textContent = e.message + ' We have updated your cart.'; ls.del('aarve.idem'); if (!store.cart.lines.length) setView('cart'); return; }
  if (e.status === 429) { msg.textContent = e.message; return; }
  msg.textContent = e.message || 'Something went wrong. Please try again.';
}

/* offline queue: orders saved on the phone, sent with the same key until the shop confirms */
const Q = 'aarve.queue';
let flushing = false, flushTimer = null;
const queue = () => ls.get(Q, []);
function enqueue(payload) {
  const q = queue();
  const ex = q.find((x) => x.idem === payload.idem);
  if (ex) { ex.payload = payload; ex.d = { name: payload.name, phone: payload.phone }; } // same order, latest details win
  else q.push({ idem: payload.idem, payload, tries: 0, next: Date.now() + 2500, t: Date.now(), d: { name: payload.name, phone: payload.phone } });
  ls.set(Q, q);
  renderPending(); scheduleFlush();
}
function scheduleFlush() {
  clearTimeout(flushTimer);
  const q = queue(); if (!q.length) return;
  const next = Math.min(...q.map((x) => x.next));
  flushTimer = setTimeout(flushQueue, clamp(next - Date.now(), 400, 300000));
}
async function flushQueue(force = false) {
  if (flushing) return;
  const q = queue(); if (!q.length) { renderPending(); return; }
  if (!navigator.onLine) { renderPending(); scheduleFlush(); return; }
  flushing = true; renderPending(true);
  try {
    for (const item of [...q]) {
      if (!force && item.next > Date.now()) continue;
      try {
        const r = await api('/api/orders', { method: 'POST', body: item.payload, timeout: 12000 });
        removeQueued(item.idem);
        onPlaced(r.order, item.d, true);
      } catch (e) {
        if (e instanceof NetError || (e instanceof ApiError && (e.status >= 500 || e.status === 429 || e.status === 408))) {
          item.tries++; item.next = Date.now() + Math.min(300, [3, 8, 20, 45, 90, 180, 300][Math.min(item.tries, 6)]) * 1000;
          saveQueueItem(item);
        } else {
          removeQueued(item.idem);
          ls.set('aarve.failed', { message: e.message || 'Your saved order could not be placed.', at: Date.now() });
          if (e.err && e.err.config) { store.cfg = { product: e.err.config.product, colours: e.err.config.colours, countries: e.err.config.countries }; ls.set('aarve.cfg', store.cfg); pruneCart(); renderBuy(); renderCart(); }
          ls.del('aarve.idem');
          toast(e.message || 'Your saved order could not be placed. Please try again.', 6000);
        }
      }
    }
  } finally { flushing = false; renderPending(); scheduleFlush(); }
}
function removeQueued(idem) { ls.set(Q, queue().filter((x) => x.idem !== idem)); }
function saveQueueItem(item) { ls.set(Q, queue().map((x) => (x.idem === item.idem ? item : x))); }
function renderPending(sending) {
  const q = queue(); const bar = $('#pendingBar');
  bar.hidden = !q.length;
  if (q.length) {
    $('#pendingText').textContent = sending ? 'Sending your order…' : navigator.onLine ? `Your order is saved on this phone and is being sent. Attempt ${q[0].tries + 1}.` : 'Your order is saved on this phone. It will be sent when you are back online.';
    $('#pendingRetry').hidden = !!sending;
  }
  syncBars();
}
$('#pendingRetry').addEventListener('click', () => flushQueue(true));
function syncBars() {
  const h = [$('#offlineBar'), $('#pendingBar')].filter((b) => !b.hidden).reduce((a, b) => a + b.offsetHeight, 0);
  document.documentElement.style.setProperty('--bar', h + 'px');
  let top = 0;
  [$('#offlineBar'), $('#pendingBar')].forEach((b) => { b.style.top = top + 'px'; if (!b.hidden) top += b.offsetHeight; });
}
function onPlaced(order, d, fromQueue) {
  ls.del('aarve.idem');
  const draft = ls.get('aarve.draft', {}); ls.set('aarve.last', { number: order.number, phone: (d && d.phone) || draft.phone || '' });
  store.cart.lines = []; saveCart(); renderCart();
  if (store.cfg) loadConfig();
  track('Purchase', { value: order.total, currency: 'PKR' });
  $('#doneNo').textContent = order.number;
  $('#doneTitle').textContent = 'Order placed';
  $('#doneText').textContent = fromQueue ? 'Your saved order reached us. We will call you on your number to confirm delivery.' : 'Thank you. We will call you on your number to confirm delivery. You pay the rider in cash when it arrives.';
  $('#doneSum').innerHTML = (order.items || []).map((i) => `<div class="r"><span>${i.qty} &times; MAG/01, ${esc(i.colour)}</span><b>${rs(i.unit_price * i.qty)}</b></div>`).join('') + `<div class="r"><span>Delivery</span><span>${order.shipping ? rs(order.shipping) : 'Free'}</span></div><div class="r"><span><b>Total, cash on delivery</b></span><b>${rs(order.total)}</b></div>`;
  openDrawer('done');
  $('#cartFoot').hidden = true;
}
$('#doneCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#doneNo').textContent); toast('Order number copied'); } catch { toast('Order number: ' + $('#doneNo').textContent, 4000); }
});
$('#doneTrack').addEventListener('click', () => openTrack(true));

/* ---------- tracking ---------- */
const STATUS_LABEL = { placed: 'Order received', new: 'Order received', confirmed: 'Confirmed', packed: 'Packed', shipped: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned' };
const fmtDate = (t) => new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function openTrack(auto) {
  const f = $('#trackForm'); const last = ls.get('aarve.last', null);
  if (last) { f.elements.number.value = f.elements.number.value || last.number; f.elements.phone.value = f.elements.phone.value || last.phone; }
  showOverlay('track', $('#trackModal'));
  if (auto && last && last.number) f.requestSubmit();
}
// the track modal id is "trackModal" but the overlay kind is 'track'
$('#trackForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target; const msg = $('#trackMsg'); msg.textContent = ''; msg.className = 'form-msg';
  const number = f.elements.number.value.trim(); const phone = f.elements.phone.value.trim();
  const errs = {};
  if (!/^(AV)?-?\s*\d{3,8}$/i.test(number)) errs.number = 'Enter your order number, like AV-1001.';
  if (!normPhone(phone)) errs.phone = 'Enter the phone number you ordered with.';
  showErrors(f, errs); if (Object.keys(errs).length) return;
  const out = $('#trackOut'); const btn = $('button[type=submit]', f);
  out.innerHTML = '<div class="skel w-full h-44"></div><br><br><div class="skel w-160 h-18"></div><br><br><div class="skel w-full h-18"></div>';
  setBusy(btn, true);
  try {
    const n = /^av/i.test(number) ? number : 'AV-' + number.replace(/\D/g, '');
    const r = await api(`/api/track?number=${encodeURIComponent(n)}&phone=${encodeURIComponent(phone)}`, { retries: 1 });
    const o = r.order;
    out.innerHTML = `<p><span class="badge">${esc(STATUS_LABEL[o.status] || o.status)}</span></p>
      <p class="order-no">${esc(o.number)}</p>
      <ul class="tl">${o.events.map((e, i) => `<li class="${i === o.events.length - 1 ? 'now' : ''}"><b>${esc(STATUS_LABEL[e.kind] || e.kind)}</b><span>${esc(fmtDate(e.at))}</span></li>`).join('')}</ul>
      ${o.tracking ? `<p class="muted">${esc(o.courier || 'Courier')} tracking: <b>${esc(o.tracking)}</b></p>` : ''}
      <p class="muted">${o.items.map((i) => `${i.qty} &times; MAG/01, ${esc(i.colour)}`).join('<br>')}<br>Total ${rs(o.total)}${o.pay_status === 'paid' ? ', paid' : ', cash on delivery'}</p>`;
    ls.set('aarve.last', { number: o.number, phone });
  } catch (e) {
    out.innerHTML = '';
    msg.className = 'form-msg bad';
    msg.textContent = e instanceof NetError ? 'We could not reach the shop. Check your connection and try again.' : e.message;
  } finally { setBusy(btn, false); }
});

/* ---------- contact + waitlist ---------- */
async function sendMessage(f, kind, msgEl, btn) {
  msgEl.textContent = ''; msgEl.className = 'form-msg';
  const d = { kind, name: f.elements.name ? f.elements.name.value.trim() : '', contact: f.elements.contact.value.trim(), body: f.elements.body ? f.elements.body.value.trim() : '', website: f.elements.website ? f.elements.website.value : '' };
  const errs = {};
  if (d.contact.length < 5) errs.contact = 'Enter an email or phone number so we can reach you.';
  if (kind === 'contact' && d.body.length < 3) errs.body = 'Write your message.';
  showErrors(f, errs); if (Object.keys(errs).length) return;
  setBusy(btn, true);
  try {
    await api('/api/messages', { method: 'POST', body: d, retries: 1 });
    msgEl.classList.add('good');
    msgEl.textContent = kind === 'waitlist' ? 'You are on the list. We will message you first.' : 'Thank you. We have your message and will reply soon.';
    f.reset();
  } catch (e) {
    msgEl.classList.add('bad');
    msgEl.textContent = e instanceof NetError ? 'We could not reach the shop. Check your connection and try again.' : (e.err && e.err.fields && Object.values(e.err.fields)[0]) || e.message;
  } finally { setBusy(btn, false); }
}
$('#contactForm').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(e.target, 'contact', $('#contactMsg'), $('button[type=submit]', e.target)); });
$('#waitForm').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(e.target, 'waitlist', $('#waitMsg'), $('button[type=submit]', e.target)); });

/* ---------- online / offline ---------- */
function netState() {
  const off = !navigator.onLine;
  $('#offlineBar').hidden = !off;
  syncBars();
  if (!off) { flushQueue(); if (store.state !== 'ready') loadConfig(); }
  else renderPending();
}
addEventListener('online', netState); addEventListener('offline', netState);
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('paused', document.hidden);
  if (!document.hidden) { flushQueue(); if (store.state !== 'ready') loadConfig(); }
});

/* ---------- motion ---------- */
// hero: the picture drifts a little against the pointer (desktop only)
(() => {
  const m = $('#heroMedia'); if (!m || reduceMotion || !matchMedia('(pointer:fine)').matches) return;
  const img = $('img', m);
  let x = 0, y = 0, cx = 0, cy = 0, raf = 0;
  const loop = () => {
    cx += (x - cx) * 0.08; cy += (y - cy) * 0.08;
    img.style.setProperty('--px', cx.toFixed(2) + 'px'); img.style.setProperty('--py', cy.toFixed(2) + 'px');
    raf = (Math.abs(x - cx) > 0.05 || Math.abs(y - cy) > 0.05) ? requestAnimationFrame(loop) : 0;
  };
  addEventListener('pointermove', (e) => { x = (e.clientX / innerWidth - 0.5) * -22; y = (e.clientY / innerHeight - 0.5) * -14; if (!raf) raf = requestAnimationFrame(loop); }, { passive: true });
})();

// parked / pulled comparison: drag the slider, or watch it sweep once
(() => {
  const c = $('#cmp'); if (!c) return;
  const r = $('input', c);
  let touched = false, played = false;
  const set = (v) => c.style.setProperty('--x', (v / 100).toFixed(3));
  r.addEventListener('input', () => { touched = true; set(+r.value); });
  if (reduceMotion) return;
  new IntersectionObserver((en, o) => {
    if (!en[0].isIntersecting || played) return;
    played = true; o.disconnect();
    const t0 = performance.now(), dur = 2800;
    const path = (p) => (p < 0.35 ? 50 - 34 * (p / 0.35) : p < 0.75 ? 16 + 68 * ((p - 0.35) / 0.4) : 84 - 34 * ((p - 0.75) / 0.25));
    const step = (t) => {
      if (touched || document.hidden) return;
      const p = Math.min(1, (t - t0) / dur);
      const v = path(p); set(v); r.value = v;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, { threshold: 0.6 }).observe(c);
})();

// the four layers: tap one, or let them cycle while the picture is on screen
(() => {
  const fig = $('#layersImg'), items = $$('#layerList li'), marks = $$('.mk', fig);
  let cur = 0, manual = false, timer = 0;
  const show = (k) => { cur = k; fig.dataset.on = k; items.forEach((li) => li.classList.toggle('on', +li.dataset.l === k)); };
  const pick = (k) => { manual = true; clearInterval(timer); show(k); };
  items.forEach((li) => li.addEventListener('click', () => pick(+li.dataset.l)));
  marks.forEach((b) => b.addEventListener('click', () => pick(+b.dataset.l)));
  if (reduceMotion) return;
  new IntersectionObserver((en) => {
    clearInterval(timer);
    if (en[0].isIntersecting && !manual) timer = setInterval(() => { if (!document.hidden) show((cur + 1) % 4); }, 3200);
  }, { threshold: 0.5 }).observe(fig);
})();

// pictures settle in as they arrive (never hidden first)
if (!reduceMotion) {
  const io = new IntersectionObserver((en) => en.forEach((x) => { if (x.isIntersecting) { x.target.classList.add('in-view'); io.unobserve(x.target); } }), { threshold: 0.25 });
  $$('.plate-fig img, .layers-img img').forEach((i) => io.observe(i));
}

// header, thread, sticky bar, nav highlight: one passive scroll handler
(() => {
  const top = $('#top'), thread = $('#thread'), sticky = $('#stickyBuy');
  const heroCta = $('#buy .cta-row'), orderSec = $('#order');
  const links = $$('.nav a');
  const secs = links.map((a) => $(a.getAttribute('href')));
  let ticking = false, ctaVisible = true, orderVisible = false;
  new IntersectionObserver((en) => { ctaVisible = en[0].isIntersecting; sticky.classList.toggle('show', !ctaVisible && !orderVisible); sticky.setAttribute('aria-hidden', String(ctaVisible || orderVisible)); $$('button', sticky).forEach((b) => { b.tabIndex = ctaVisible || orderVisible ? -1 : 0; }); }, { threshold: 0 }).observe(heroCta);
  new IntersectionObserver((en) => { orderVisible = en[0].isIntersecting; sticky.classList.toggle('show', !ctaVisible && !orderVisible); sticky.setAttribute('aria-hidden', String(ctaVisible || orderVisible)); $$('button', sticky).forEach((b) => { b.tabIndex = ctaVisible || orderVisible ? -1 : 0; }); }, { threshold: 0.15 }).observe(orderSec);
  const update = () => {
    ticking = false;
    const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
    top.classList.toggle('solid', y > 12);
    thread.style.setProperty('--prog', max > 0 ? (y / max).toFixed(4) : 0);
    let cur = -1;
    secs.forEach((s, i) => { if (s && s.getBoundingClientRect().top < innerHeight * 0.45) cur = i; });
    links.forEach((a, i) => a.classList.toggle('on', i === cur));
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener('resize', update);
  update();
})();

// numbers settle in; FAQ opens smoothly
new IntersectionObserver((en, o) => { if (en[0].isIntersecting) { $('#bigNum').classList.add('in'); o.disconnect(); } }, { threshold: 0.4 }).observe($('#bigNum'));
$$('.acc details').forEach((d) => {
  const sum = $('summary', d), body = $('summary + div', d);
  sum.addEventListener('click', (e) => {
    e.preventDefault();
    if (reduceMotion) { d.open = !d.open; return; }
    if (d.dataset.anim) return;
    d.dataset.anim = '1';
    const open = d.open;
    if (!open) d.open = true;
    const h = body.scrollHeight;
    const a = body.animate({ height: open ? [h + 'px', '0px'] : ['0px', h + 'px'] }, { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    a.onfinish = () => { if (open) d.open = false; delete d.dataset.anim; body.style.height = ''; };
    a.oncancel = () => { delete d.dataset.anim; };
  });
});

/* ---------- boot ---------- */
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  const had = !!navigator.serviceWorker.controller;
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  // a new version took over: refresh once so nobody sits on an old page
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had || sessionStorage.getItem('aarve.reloaded') || openOverlay) return;
    try { sessionStorage.setItem('aarve.reloaded', '1'); } catch {}
    location.reload();
  });
}
loadPixels();
renderBuy(); renderCart(); renderPending(); netState();
loadConfig();
if (queue().length) scheduleFlush();
document.body.classList.toggle('paused', document.hidden);
addEventListener('resize', syncBars);
})();
