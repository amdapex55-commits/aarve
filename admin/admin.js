/* AARVE admin. See and process orders. Vanilla JS. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rs = (n) => 'Rs ' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }, del(k) { try { localStorage.removeItem(k); } catch {} } };
const API = (() => {
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const q = new URLSearchParams(location.search).get('api');
  return ((local ? (q || 'http://localhost:8787') : (window.AARVE || {}).api || '')).replace(/\/$/, '');
})();
const STATUS = { new: 'New', confirmed: 'Confirmed', packed: 'Packed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned' };
const NEXT = { new: ['confirmed', 'Confirm order'], confirmed: ['packed', 'Mark packed'], packed: ['shipped', 'Mark shipped'], shipped: ['delivered', 'Mark delivered, cash collected'] };
const pkt = (t, o) => new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', ...(o || { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) });
const ago = (t) => { const s = Math.max(0, (Date.now() - new Date(t)) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return pkt(t, { day: 'numeric', month: 'short' }); };

/* ---------- api ---------- */
class ApiError extends Error { constructor(status, err) { super(err.message || 'Request failed'); this.status = status; this.code = err.code; this.err = err; } }
class NetError extends Error {}
let session = ls.get('aarve.admin', null);
async function call(path, { method = 'GET', body, retries = 0, raw = false } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      clearTimeout(t); setLive(true);
      if (raw && r.ok) return r;
      let data = null; try { data = await r.json(); } catch {}
      if (r.status === 401 && session) { signOut('Your session ended. Please sign in again.'); throw new ApiError(401, { message: 'Signed out' }); }
      if (!r.ok) { const e = new ApiError(r.status, (data && data.error) || {}); if (r.status >= 500 && i < retries) { last = e; await sleep(700 * 2 ** i); continue; } throw e; }
      return data;
    } catch (e) {
      clearTimeout(t);
      if (e instanceof ApiError) throw e;
      last = new NetError('Network'); setLive(false);
      if (i < retries) await sleep(700 * 2 ** i);
    }
  }
  throw last;
}
function setLive(ok) {
  const l = $('#live'); if (!l) return;
  l.classList.toggle('off', !ok); $('#liveText').textContent = ok ? 'Live' : 'Offline';
  const b = $('#netBanner');
  if (!ok) { b.hidden = false; b.innerHTML = 'Cannot reach the shop server. <button type="button" id="netRetry">Retry now</button>'; $('#netRetry').onclick = () => refresh(true); } else b.hidden = true;
}
addEventListener('online', () => refresh(true)); addEventListener('offline', () => setLive(false));
function toast(m, bad) { const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = m; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3200); }
function busy(btn, on) { btn.classList.toggle('busy', on); btn.disabled = on; }
function beep() { try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); const g = a.createGain(); o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); setTimeout(() => { o.frequency.value = 1175; }, 120); setTimeout(() => { o.stop(); a.close(); }, 300); } catch {} }

/* ---------- login ---------- */
function showApp() { $('#login').hidden = true; $('#app').hidden = false; boot(); }
function signOut(msg) {
  session = null; ls.del('aarve.admin'); clearInterval(pollT);
  $('#app').hidden = true; $('#login').hidden = false; $('#loginMsg').textContent = msg || ''; closePanel(true);
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target; const btn = $('button', f); const msg = $('#loginMsg'); msg.textContent = '';
  const pw = f.elements.password.value; if (!pw) { msg.textContent = 'Enter the password.'; return; }
  busy(btn, true);
  try {
    const r = await call('/api/admin/login', { method: 'POST', body: { password: pw } });
    session = { token: r.token, exp: Date.now() + r.expires_in * 1000 }; ls.set('aarve.admin', session); f.reset(); showApp();
  } catch (er) { msg.textContent = er instanceof NetError ? 'Cannot reach the server. Check your connection and try again.' : er.message; }
  finally { busy(btn, false); }
});
$('#logoutBtn').addEventListener('click', () => signOut());

/* ---------- state ---------- */
const st = { tab: 'orders', status: 'open', q: '', orders: [], more: false, counts: {}, latest: 0, firstPoll: true, summary: null };
let pollT = 0, loadSeq = 0;

function boot() {
  renderChips(); renderStats(); loadOrders(true); loadSummary();
  clearInterval(pollT); pollT = setInterval(() => { if (!document.hidden) loadSummary(); }, 15000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && session) refresh(); });

/* ---------- tabs ---------- */
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  st.tab = b.dataset.tab;
  $$('#tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  ['orders', 'settings', 'messages'].forEach((t) => { $('#tab-' + t).hidden = t !== st.tab; });
  if (st.tab === 'settings') loadSettings(); if (st.tab === 'messages') loadMessages();
});
function refresh(force) { if (!session) return; loadSummary(); if (st.tab === 'orders') loadOrders(true); }

/* ---------- summary + stats ---------- */
async function loadSummary() {
  try {
    const s = await call('/api/admin/summary', { retries: 1 });
    st.summary = s; st.counts = s.counts;
    if (!st.firstPoll && s.latest_order_id > st.latest) { beep(); toast('New order received'); if (st.tab === 'orders') loadOrders(true, true); }
    st.latest = s.latest_order_id; st.firstPoll = false;
    renderStats(); renderChips();
    const nw = s.counts.new; $('#tabNew').hidden = !nw; $('#tabNew').textContent = nw;
    $('#tabMsg').hidden = !s.unread_messages; $('#tabMsg').textContent = s.unread_messages;
    document.title = (nw ? `(${nw}) ` : '') + 'AARVE Orders';
  } catch (e) { /* the banner already shows the connection problem */ }
}
function renderStats() {
  const s = st.summary;
  const cell = (label, val, alert) => `<div class="stat${alert ? ' alert' : ''}"><span>${label}</span><b>${val}</b></div>`;
  $('#stats').innerHTML = s
    ? cell('To confirm', s.counts.new, s.counts.new > 0) + cell('In delivery', s.counts.confirmed + s.counts.packed + s.counts.shipped) + cell('Orders today', s.today.orders) + cell('Cash to collect', rs(s.pipeline_revenue))
    : [1, 2, 3, 4].map(() => '<div class="stat"><span>&nbsp;</span><b><i class="skelrow" style="display:block;height:30px;border:0"></i></b></div>').join('');
}
function renderChips() {
  const c = st.counts; const open = (c.new || 0) + (c.confirmed || 0) + (c.packed || 0) + (c.shipped || 0);
  const all = Object.values(c).reduce((a, b) => a + b, 0);
  const defs = [['open', 'Open', open], ['new', 'New', c.new], ['confirmed', 'Confirmed', c.confirmed], ['packed', 'Packed', c.packed], ['shipped', 'Shipped', c.shipped], ['delivered', 'Delivered', c.delivered], ['cancelled', 'Cancelled', c.cancelled], ['returned', 'Returned', c.returned], ['all', 'All', all]];
  $('#chips').innerHTML = defs.map(([k, l, n]) => `<button class="chip" role="tab" data-s="${k}" aria-selected="${st.status === k}">${l}${n != null ? `<b>${n}</b>` : ''}</button>`).join('');
}
$('#chips').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; st.status = b.dataset.s; renderChips(); loadOrders(true); });
let qT = 0; $('#q').addEventListener('input', (e) => { clearTimeout(qT); qT = setTimeout(() => { st.q = e.target.value.trim(); loadOrders(true); }, 300); });

/* ---------- orders list ---------- */
async function loadOrders(reset, highlight) {
  const seq = ++loadSeq; const list = $('#list');
  if (reset && !st.orders.length) list.innerHTML = '<div class="skelrow"></div>'.repeat(5);
  try {
    const before = reset ? 0 : (st.orders.length ? st.orders[st.orders.length - 1].id : 0);
    const qs = new URLSearchParams({ status: st.status, limit: 30 }); if (st.q) qs.set('q', st.q); if (before) qs.set('before', before);
    const d = await call('/api/admin/orders?' + qs, { retries: 2 });
    if (seq !== loadSeq) return;
    const known = new Set(st.orders.map((o) => o.id));
    st.orders = reset ? d.orders : st.orders.concat(d.orders); st.more = d.more;
    renderList(highlight ? new Set(d.orders.filter((o) => !known.has(o.id)).map((o) => o.id)) : null);
  } catch (e) {
    if (seq !== loadSeq || e.status === 401) return;
    if (!st.orders.length || reset) list.innerHTML = `<div class="errbox">${e instanceof NetError ? 'Cannot reach the shop server.' : esc(e.message)}<br><button class="ghost" id="listRetry" type="button">Try again</button></div>`;
    const b = $('#listRetry'); if (b) b.onclick = () => loadOrders(true);
  }
}
function renderList(fresh) {
  const list = $('#list');
  if (!st.orders.length) { list.innerHTML = `<div class="empty">${st.q ? 'No orders match your search.' : 'No orders here yet.'}</div>`; $('#moreBtn').hidden = true; return; }
  list.innerHTML = st.orders.map((o) => `<button class="row${fresh && fresh.has(o.id) ? ' fresh' : ''}" data-id="${o.id}">
    <div class="meta"><span class="no">${esc(o.number)}</span><span class="badge s-${o.status}">${STATUS[o.status]}</span><span class="when">${ago(o.created_at)}</span></div>
    <div class="who"><b>${esc(o.name)}</b><span>${esc(o.city)} &middot; ${o.items.map((i) => `${i.qty} &times; ${esc(i.colour)}`).join(', ')}</span></div>
    <div class="amt"><b>${rs(o.total)}</b><span class="when">${o.pay_status === 'paid' ? 'Paid' : 'Cash on delivery'}</span></div></button>`).join('');
  $('#moreBtn').hidden = !st.more;
}
$('#list').addEventListener('click', (e) => { const r = e.target.closest('.row'); if (r) openOrder(+r.dataset.id); });
$('#moreBtn').addEventListener('click', async (e) => { busy(e.target, true); await loadOrders(false); busy(e.target, false); });

/* ---------- order panel ---------- */
let cur = null;
function closePanel(silent) { const p = $('#panel'); p.classList.remove('open'); p.setAttribute('aria-hidden', 'true'); p.setAttribute('inert', ''); $('#veil').hidden = true; cur = null; }
$('#panelClose').addEventListener('click', () => closePanel()); $('#veil').addEventListener('click', () => closePanel());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });
async function openOrder(id) {
  const p = $('#panel'); p.removeAttribute('inert'); p.setAttribute('aria-hidden', 'false'); p.classList.add('open'); $('#veil').hidden = false;
  $('#panelTitle').textContent = ''; $('#panelBadge').innerHTML = '';
  $('#panelBody').innerHTML = '<div class="skelrow"></div><div class="skelrow"></div><div class="skelrow"></div>';
  try { const d = await call('/api/admin/orders/' + id, { retries: 2 }); cur = d.order; renderPanel(); }
  catch (e) { if (e.status === 401) return; $('#panelBody').innerHTML = `<div class="errbox">${e instanceof NetError ? 'Cannot reach the shop server.' : esc(e.message)}<br><button class="ghost" id="pRetry" type="button">Try again</button></div>`; $('#pRetry').onclick = () => openOrder(id); }
}
function waLink(phone) { const d = String(phone).replace(/\D/g, ''); return 'https://wa.me/' + (d.startsWith('0') ? '92' + d.slice(1) : d); }
function renderPanel() {
  const o = cur; $('#panelTitle').textContent = o.number; $('#panelBadge').innerHTML = `<span class="badge s-${o.status}">${STATUS[o.status]}</span>`;
  const nx = NEXT[o.status];
  const dead = o.status === 'cancelled' || o.status === 'returned';
  $('#panelBody').innerHTML = `
  <div class="card"><h3>Customer</h3>
    <dl class="kv"><dt>Name</dt><dd>${esc(o.name)}</dd><dt>Phone</dt><dd>${esc(o.phone)}</dd><dt>City</dt><dd>${esc(o.city)}</dd><dt>Address</dt><dd>${esc(o.address)}</dd>${o.notes ? `<dt>Note</dt><dd>${esc(o.notes)}</dd>` : ''}<dt>Placed</dt><dd>${esc(pkt(o.created_at, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</dd></dl>
    <div class="acts"><a href="tel:${esc(o.phone)}">Call</a><a href="${waLink(o.phone)}" target="_blank" rel="noopener">WhatsApp</a><button type="button" data-copy="${esc(o.name + '\n' + o.phone + '\n' + o.address + ', ' + o.city)}">Copy address</button></div></div>
  <div class="card items"><h3>Order</h3>${o.items.map((i) => `<div><span>${i.qty} &times; ${esc(i.colour)}</span><b>${rs(i.unit_price * i.qty)}</b></div>`).join('')}
    <div><span>Delivery</span><span>${o.shipping ? rs(o.shipping) : 'Free'}</span></div>
    <div class="tot"><span>${o.pay_status === 'paid' ? 'Paid' : 'Collect on delivery'}</span><span>${rs(o.total)}</span></div></div>
  <div class="card flow"><h3>Process</h3>
    ${nx ? `<button class="btn" id="nextBtn" type="button"><span class="lbl">${nx[1]}</span><span class="spin"></span></button>` : ''}
    <label>Set status<select id="statusSel">${Object.keys(STATUS).map((s) => `<option value="${s}"${s === o.status ? ' selected' : ''}>${STATUS[s]}</option>`).join('')}</select></label>
    ${!dead ? `<label>Payment<select id="paySel"><option value="unpaid"${o.pay_status === 'unpaid' ? ' selected' : ''}>Cash not yet collected</option><option value="paid"${o.pay_status === 'paid' ? ' selected' : ''}>Cash collected</option></select></label>` : ''}
    <p class="hint">Cancelling or returning puts the stock back. Reopening takes it again.</p></div>
  <div class="card fields"><h3>Courier</h3><label>Courier<input id="courier" value="${esc(o.courier)}" maxlength="60" placeholder="NovaX, TCS, Leopards"></label><label>Tracking number<input id="tracking" value="${esc(o.tracking)}" maxlength="80"></label>
    <button class="ghost" id="saveShip" type="button">Save courier details</button></div>
  <div class="card fields"><h3>Internal note</h3><label><span class="sr">Note</span><textarea id="note" rows="3" maxlength="600" placeholder="Only you can see this">${esc(o.admin_note)}</textarea></label><button class="ghost" id="saveNote" type="button">Save note</button></div>
  <div class="card"><h3>History</h3><ul class="tl">${o.events.slice().reverse().map((e) => `<li><b>${esc(e.kind === 'placed' ? 'Order placed' : e.kind === 'note' ? 'Note' : e.kind === 'payment' ? 'Payment' : e.kind === 'update' ? 'Updated' : STATUS[e.kind] || e.kind)}</b>${e.detail ? ' &middot; ' + esc(e.detail) : ''}<span>${esc(pkt(e.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span></li>`).join('')}</ul></div>
  <button class="ghost" id="printBtn" type="button">Print packing slip</button>`;
}
async function patch(body, btn) {
  if (!cur) return; if (btn) busy(btn, true);
  try { const d = await call('/api/admin/orders/' + cur.id, { method: 'PATCH', body }); cur = d.order; renderPanel(); const row = st.orders.find((x) => x.id === cur.id); if (row) Object.assign(row, { status: cur.status, pay_status: cur.pay_status, courier: cur.courier, tracking: cur.tracking }); renderList(); loadSummary(); toast('Saved'); }
  catch (e) { if (e.status !== 401) toast(e instanceof NetError ? 'Cannot reach the server. Nothing was saved. Try again.' : e.message, true); renderPanel(); }
}
$('#panelBody').addEventListener('click', (e) => {
  if (!cur) return;
  const nb = e.target.closest('#nextBtn'); if (nb) { patch({ status: NEXT[cur.status][0] }, nb); return; }
  if (e.target.closest('#saveShip')) { patch({ courier: $('#courier').value, tracking: $('#tracking').value }, e.target.closest('#saveShip')); return; }
  if (e.target.closest('#saveNote')) { patch({ admin_note: $('#note').value }, e.target.closest('#saveNote')); return; }
  const cp = e.target.closest('[data-copy]'); if (cp) { navigator.clipboard.writeText(cp.dataset.copy).then(() => toast('Copied'), () => toast('Could not copy', true)); return; }
  if (e.target.closest('#printBtn')) printSlip();
});
$('#panelBody').addEventListener('change', (e) => {
  if (!cur) return;
  if (e.target.id === 'statusSel') {
    const v = e.target.value; if (v === cur.status) return;
    if (['cancelled', 'returned'].includes(v) && !confirm(`Mark ${cur.number} as ${v}? Stock will be put back.`)) { e.target.value = cur.status; return; }
    patch({ status: v });
  }
  if (e.target.id === 'paySel') patch({ pay_status: e.target.value });
});
function printSlip() {
  const o = cur;
  $('#slip').innerHTML = `<h1>AARVE</h1><p>Packing slip &middot; ${esc(o.number)} &middot; ${esc(pkt(o.created_at))}</p>
  <p><b>${esc(o.name)}</b><br>${esc(o.phone)}<br>${esc(o.address)}<br>${esc(o.city)}</p>
  <table><tr><th>Item</th><th>Qty</th><th>Price</th></tr>${o.items.map((i) => `<tr><td>MAG/01, ${esc(i.colour)}</td><td>${i.qty}</td><td>${rs(i.unit_price * i.qty)}</td></tr>`).join('')}</table>
  <p>Delivery: ${o.shipping ? rs(o.shipping) : 'Free'}</p><p class="big">${o.pay_status === 'paid' ? 'PAID' : 'COLLECT ON DELIVERY: ' + rs(o.total)}</p>${o.notes ? `<p>Customer note: ${esc(o.notes)}</p>` : ''}`;
  window.print();
}

/* ---------- export ---------- */
$('#exportBtn').addEventListener('click', async (e) => {
  busy(e.currentTarget, true);
  try { const r = await call('/api/admin/export?status=' + (st.status === 'open' ? 'open' : st.status), { raw: true, retries: 1 }); const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'aarve-orders.csv'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
  catch (er) { if (er.status !== 401) toast('Could not export. Try again.', true); }
  finally { busy(e.currentTarget, false); }
});

/* ---------- settings ---------- */
let cfgCache = null;
async function loadSettings() {
  const f = $('#settingsForm');
  try {
    const d = await call('/api/admin/settings', { retries: 2 }); cfgCache = d;
    for (const k of ['product_name', 'price', 'shipping_fee', 'max_qty', 'announcement', 'delivery_text']) f.elements[k].value = d.settings[k] ?? '';
    renderColours(d.colours);
  } catch (e) { if (e.status !== 401) $('#settingsMsg').textContent = 'Could not load settings. ' + (e instanceof NetError ? 'Check your connection.' : e.message); }
}
function renderColours(cols) {
  $('#colourRows').innerHTML = cols.map((c, i) => `<div class="colour" data-id="${esc(c.id)}"><input type="color" value="${esc(c.hex)}" aria-label="Colour swatch"><label>Name<input class="cn" value="${esc(c.name)}" maxlength="30"></label><label>Stock<input class="cs" inputmode="numeric" value="${c.stock}"></label><label class="chk"><input type="checkbox" class="ca"${c.available ? ' checked' : ''}> Sell this colour</label></div>`).join('');
}
$('#addColour').addEventListener('click', () => { const w = $('#colourRows'); const d = document.createElement('div'); d.className = 'colour'; d.dataset.id = ''; d.innerHTML = '<input type="color" value="#3b1512" aria-label="Colour swatch"><label>Name<input class="cn" maxlength="30"></label><label>Stock<input class="cs" inputmode="numeric" value="0"></label><label class="chk"><input type="checkbox" class="ca" checked> Sell this colour</label>'; w.appendChild(d); $('.cn', d).focus(); });
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target; const btn = $('button[type=submit]', f); const msg = $('#settingsMsg'); msg.className = 'msg'; msg.textContent = '';
  $$('.err', f).forEach((x) => { x.textContent = ''; });
  const body = { settings: Object.fromEntries(['product_name', 'price', 'shipping_fee', 'max_qty', 'announcement', 'delivery_text'].map((k) => [k, f.elements[k].value])), colours: $$('.colour', f).map((r) => ({ id: r.dataset.id, name: $('.cn', r).value.trim(), hex: $('input[type=color]', r).value, stock: $('.cs', r).value.trim(), available: $('.ca', r).checked })) };
  busy(btn, true);
  try { const d = await call('/api/admin/settings', { method: 'PUT', body }); cfgCache = d; renderColours(d.colours); msg.className = 'msg good'; msg.textContent = 'Saved. The shop uses these now.'; }
  catch (er) {
    if (er.status === 401) return;
    if (er.err && er.err.fields) { for (const [k, v] of Object.entries(er.err.fields)) { const el = f.elements[k]; if (el) { const em = el.parentElement.querySelector('.err'); if (em) em.textContent = v; } else msg.textContent += v + ' '; } msg.textContent = msg.textContent || 'Please fix the highlighted fields.'; }
    else msg.textContent = er instanceof NetError ? 'Cannot reach the server. Nothing was saved. Try again.' : er.message;
  } finally { busy(btn, false); }
});

/* ---------- messages ---------- */
async function loadMessages() {
  const box = $('#msgList'); box.innerHTML = '<div class="skelrow"></div>'.repeat(3);
  try {
    const d = await call('/api/admin/messages', { retries: 2 });
    box.innerHTML = d.messages.length ? d.messages.map((m) => `<div class="msgrow${m.handled ? ' done' : ''}"><div class="top"><span><b>${m.kind === 'waitlist' ? 'UAE / UK list' : 'Message'}</b> &middot; ${esc(m.name || 'No name')} &middot; ${esc(m.contact)}</span><span>${esc(pkt(m.created_at))}</span></div>${m.body ? `<p>${esc(m.body)}</p>` : ''}<div class="acts"><button type="button" data-h="${m.id}" data-v="${m.handled ? 0 : 1}">${m.handled ? 'Mark as new' : 'Mark as done'}</button></div></div>`).join('') : '<div class="empty">No messages yet.</div>';
  } catch (e) { if (e.status !== 401) { box.innerHTML = `<div class="errbox">${e instanceof NetError ? 'Cannot reach the shop server.' : esc(e.message)}<br><button class="ghost" id="mRetry" type="button">Try again</button></div>`; $('#mRetry').onclick = loadMessages; } }
}
$('#msgList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-h]'); if (!b) return; busy(b, true);
  try { await call('/api/admin/messages/' + b.dataset.h, { method: 'PATCH', body: { handled: b.dataset.v === '1' } }); await loadMessages(); loadSummary(); } catch { toast('Could not update. Try again.', true); busy(b, false); }
});

/* ---------- start ---------- */
if (session && session.exp > Date.now()) showApp(); else { ls.del('aarve.admin'); session = null; }
setInterval(() => { if (st.tab === 'orders' && !$('#app').hidden) renderList(); }, 60000);
})();
