/* Ronin admin panel — talks ONLY to /admin-api on this (admin) origin. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (n) => new Intl.NumberFormat('fa-IR').format(n ?? 0);
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('fa-IR') : '—');
let csrf = null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `خطا ${res.status}`);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── login ────────────────────────────────────────────────────────────────
let otpSentTo = null;
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error'); err.textContent = '';
  const phone = $('#login-phone').value.trim();
  try {
    if (!otpSentTo) {
      await api('/admin-api/auth/otp/request', { method: 'POST', body: { phone } });
      otpSentTo = phone;
      $('#login-code-row').classList.remove('hidden');
      $('#login-submit').textContent = 'ورود';
    } else {
      const out = await api('/admin-api/auth/otp/verify', { method: 'POST', body: { phone, code: $('#login-code').value.trim() } });
      csrf = out.csrfToken;
      boot(out.phone);
    }
  } catch (e2) { err.textContent = e2.message; }
});

async function boot(phone) {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#admin-phone').textContent = phone || '';
  await loadOverview();
  await loadSettings();
  await loadOrders();
}
async function restore() {
  try {
    const s = await api('/admin-api/session');
    csrf = s.csrfToken;
    boot(s.phone);
  } catch { $('#login-view').classList.remove('hidden'); }
}
$('#logout-btn').addEventListener('click', async () => {
  try { await api('/admin-api/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
  location.reload();
});

// ── navigation ───────────────────────────────────────────────────────────
$$('.nav').forEach((b) => b.addEventListener('click', () => {
  $$('.nav').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + b.dataset.view).classList.remove('hidden');
  if (b.dataset.view === 'audit') void loadAudit();
  if (b.dataset.view === 'users') void loadUsers();
}));

// ── overview ─────────────────────────────────────────────────────────────
async function loadOverview() {
  const o = await api('/admin-api/overview');
  $('#st-users').textContent = fmt(o.users);
  $('#st-revenue').textContent = fmt(o.revenueRials);
  $('#st-pending').textContent = fmt(o.pendingOrders);
  $('#st-consumed').textContent = fmt(o.tokensConsumed);
  $('#st-granted').textContent = fmt(o.tokensGranted);
  const badge = $('#nav-pending');
  badge.textContent = fmt(o.pendingOrders);
  badge.classList.toggle('hidden', !o.pendingOrders);
}

// ── orders ───────────────────────────────────────────────────────────────
function statusFa(s) { return { pending: 'در انتظار', approved: 'تأییدشده', rejected: 'ردشده' }[s] || s; }
async function loadOrders() {
  const status = $('#orders-filter').value;
  const { orders } = await api('/admin-api/orders' + (status ? `?status=${status}` : ''));
  $('#orders-list').innerHTML = orders.length ? `<table><thead><tr>
    <th>#</th><th>کاربر</th><th>بسته</th><th>مبلغ (ریال)</th><th>رسید</th><th>وضعیت</th><th></th>
    </tr></thead><tbody>${orders.map((o) => `<tr>
      <td>${o.id}</td><td dir="ltr">${esc(o.userPhone || '')}</td><td>${esc(o.packTitle)}<br><span class="muted">${fmt(o.tokens)} توکن</span></td>
      <td>${fmt(o.priceRials)}</td>
      <td>${o.receiptUrl ? `<a href="${esc(o.receiptUrl)}" target="_blank" rel="noopener">مشاهده رسید</a>` : '—'}${o.duplicateImage ? ' <span class="pill rejected">عکس تکراری</span>' : ''}</td>
      <td><span class="pill ${o.status}">${statusFa(o.status)}</span></td>
      <td><button class="ghost" data-order="${o.id}">بررسی</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">سفارشی نیست.</p>';
  $$('#orders-list [data-order]').forEach((b) => b.addEventListener('click', () => void showOrder(Number(b.dataset.order))));
}
$('#orders-filter').addEventListener('change', () => void loadOrders());
$('#orders-refresh').addEventListener('click', () => { void loadOrders(); void loadOverview(); });

async function showOrder(id) {
  const { order, user } = await api(`/admin-api/orders/${id}`);
  const box = $('#order-detail');
  box.classList.remove('hidden');
  box.innerHTML = `<h2>سفارش #${order.id}</h2>
    <dl class="kv">
      <dt>کاربر</dt><dd dir="ltr">${esc(user?.phone || '')} ${esc(user?.name || '')}</dd>
      <dt>بسته</dt><dd>${esc(order.packTitle)} — ${fmt(order.tokens)} توکن</dd>
      <dt>مبلغ مورد انتظار</dt><dd>${fmt(order.priceRials)} ریال</dd>
      <dt>ثبت</dt><dd>${fmtDate(order.createdAt)}</dd>
      ${order.duplicateImage ? `<dt>هشدار</dt><dd><span class="pill rejected">این عکس رسید در ادعای دیگری هم استفاده شده است</span></dd>` : ''}
    </dl>
    ${order.receiptUrl ? `<p><a href="${esc(order.receiptUrl)}" target="_blank" rel="noopener"><img src="${esc(order.receiptUrl)}" alt="رسید پرداخت" style="max-width:420px;max-height:520px;border-radius:10px;border:1px solid rgba(255,255,255,.12)"></a></p>` : '<p class="muted">رسیدی ثبت نشده است.</p>'}
    <dl class="kv">
      <dt>وضعیت</dt><dd><span class="pill ${order.status}">${statusFa(order.status)}</span></dd>
      ${order.reviewedAt ? `<dt>بررسی</dt><dd>${esc(order.reviewedBy || '')} — ${fmtDate(order.reviewedAt)}${order.receivedAmountRials != null ? ` — دریافتی: ${fmt(order.receivedAmountRials)} ریال` : ''}</dd>` : ''}
      ${order.rejectReason ? `<dt>دلیل رد</dt><dd>${esc(order.rejectReason)}</dd>` : ''}
      ${order.adminNote ? `<dt>یادداشت مدیر</dt><dd>${esc(order.adminNote)}</dd>` : ''}
    </dl>
    ${order.status === 'pending' ? `<div class="row">
        <label style="flex:1">مبلغ دریافتی واقعی (ریال)<input id="rev-amount" type="number" dir="ltr" value="${order.priceRials}"></label>
      </div>
      <label>یادداشت مدیر (نمایش به کاربر، اختیاری)<input id="rev-note" maxlength="200"></label>
      <label>دلیل رد (برای رد کردن الزامی، نمایش به کاربر)<input id="rev-reason"></label>
      <div class="row">
        <button id="rev-approve">تأیید و شارژ اعتبار</button>
        <button id="rev-reject" class="danger">رد سفارش</button>
      </div><p id="rev-msg" class="error"></p>` : ''}`;
  box.scrollIntoView({ behavior: 'smooth' });
  if (order.status !== 'pending') return;
  const review = async (action) => {
    try {
      const out = await api(`/admin-api/orders/${id}/review`, {
        method: 'POST',
        body: {
          action,
          receivedAmountRials: action === 'approve' ? Number($('#rev-amount').value) : undefined,
          note: $('#rev-note').value || undefined,
          reason: action === 'reject' ? $('#rev-reason').value : undefined,
        },
      });
      alert(action === 'approve' ? `تأیید شد؛ ${fmt(out.grantedTokens)} توکن شارژ شد.` : 'سفارش رد شد.');
      await loadOrders(); await loadOverview(); box.classList.add('hidden');
    } catch (e) { $('#rev-msg').textContent = e.message; }
  };
  $('#rev-approve').addEventListener('click', () => void review('approve'));
  $('#rev-reject').addEventListener('click', () => void review('reject'));
}

// ── users ────────────────────────────────────────────────────────────────
async function loadUsers() {
  const q = $('#user-search').value.trim();
  const { users } = await api('/admin-api/users' + (q ? `?search=${encodeURIComponent(q)}` : ''));
  $('#users-list').innerHTML = users.length ? `<table><thead><tr><th>#</th><th>موبایل</th><th>نام</th><th>موجودی (توکن)</th><th>وضعیت</th><th>آخرین ورود</th><th></th></tr></thead>
    <tbody>${users.map((u) => `<tr><td>${u.id}</td><td dir="ltr">${esc(u.phone)}</td><td>${esc(u.name || '—')}</td>
      <td>${fmt(u.balanceTokens)}</td><td>${u.isActive ? 'فعال' : '<span class="pill rejected">غیرفعال</span>'}</td>
      <td>${fmtDate(u.lastLoginAt)}</td><td><button class="ghost" data-user="${u.id}">پرونده</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">کاربری نیست.</p>';
  $$('#users-list [data-user]').forEach((b) => b.addEventListener('click', () => void showUser(Number(b.dataset.user))));
}
$('#user-search-btn').addEventListener('click', () => void loadUsers());

async function showUser(id) {
  const d = await api(`/admin-api/users/${id}`);
  const box = $('#user-detail');
  box.classList.remove('hidden');
  box.innerHTML = `<h2>کاربر #${d.user.id} — <span dir="ltr">${esc(d.user.phone)}</span></h2>
    <dl class="kv"><dt>نام</dt><dd>${esc(d.user.name || '—')}</dd>
      <dt>موجودی</dt><dd>${fmt(d.balanceTokens)} توکن</dd>
      <dt>وضعیت</dt><dd>${d.user.isActive ? 'فعال' : 'غیرفعال'}</dd>
      <dt>عضویت</dt><dd>${fmtDate(d.user.createdAt)}</dd></dl>
    <div class="row">
      <label style="flex:1">شارژ/کسر دستی (توکن؛ منفی = کسر)<input id="ch-amount" type="number" dir="ltr"></label>
      <label style="flex:2">یادداشت (الزامی)<input id="ch-note" placeholder="دلیل تغییر موجودی"></label>
      <button id="ch-apply">اعمال</button>
      <button id="ch-toggle" class="ghost">${d.user.isActive ? 'غیرفعال‌کردن حساب' : 'فعال‌کردن حساب'}</button>
    </div><p id="ch-msg" class="error"></p>
    <h2>دفتر کل (لجر)</h2>
    ${d.ledger.length ? `<table><thead><tr><th>زمان</th><th>نوع</th><th>تغییر</th><th>مانده</th><th>یادداشت</th></tr></thead><tbody>
      ${d.ledger.map((l) => `<tr><td>${fmtDate(l.createdAt)}</td><td>${esc(l.kind)}</td><td dir="ltr">${fmt(l.deltaTokens)}</td><td>${fmt(l.balanceAfter)}</td><td>${esc(l.note || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">رکوردی نیست.</p>'}
    <h2>سفارش‌ها</h2>
    ${d.orders.length ? `<table><thead><tr><th>#</th><th>بسته</th><th>مبلغ</th><th>وضعیت</th></tr></thead><tbody>
      ${d.orders.map((o) => `<tr><td>${o.id}</td><td>${esc(o.packTitle)}</td><td>${fmt(o.priceRials)}</td><td><span class="pill ${o.status}">${statusFa(o.status)}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">سفارشی نیست.</p>'}`;
  box.scrollIntoView({ behavior: 'smooth' });
  $('#ch-apply').addEventListener('click', async () => {
    try {
      const out = await api(`/admin-api/users/${id}/charge`, { method: 'POST', body: { tokens: Number($('#ch-amount').value), note: $('#ch-note').value } });
      alert(`انجام شد. موجودی جدید: ${fmt(out.balanceTokens)} توکن`);
      await showUser(id); await loadOverview();
    } catch (e) { $('#ch-msg').textContent = e.message; }
  });
  $('#ch-toggle').addEventListener('click', async () => {
    await api(`/admin-api/users/${id}/toggle-active`, { method: 'POST', body: {} });
    await showUser(id);
  });
}

// ── settings / packs / models ────────────────────────────────────────────
let settings = null;
async function loadSettings() {
  settings = await api('/admin-api/settings');
  $('#card-number').value = settings.card.number || '';
  $('#card-holder').value = settings.card.holder || '';
  $('#card-bank').value = settings.card.bank || '';
  $('#cfg-per-usd').value = settings.tokenConfig.tokensPerUsd;
  $('#cfg-default-mult').value = settings.tokenConfig.defaultMultiplier;
  $('#packs-per-usd').textContent = fmt(settings.tokenConfig.tokensPerUsd);
  $('#sms-provider').textContent = settings.smsProvider;
  $('#sms-templates').textContent = 'الگوهای تنظیم‌شده: ' + Object.entries(settings.smsTemplatesConfigured).map(([k, v]) => `${k}: ${v ? '✓' : '✗'}`).join('، ');
  renderPacks(); renderModels();
}
function renderPacks() {
  $('#packs-editor').innerHTML = settings.packs.map((p, i) => `<div class="editor-row" data-pack="${i}">
    <input data-f="id" dir="ltr" value="${esc(p.id)}" placeholder="id">
    <input data-f="title" value="${esc(p.title)}" placeholder="عنوان">
    <input data-f="usd" type="number" step="0.5" min="0" dir="ltr" value="${p.usd}" placeholder="دلار" title="دلار">
    <input data-f="priceRials" type="number" min="0" dir="ltr" value="${p.priceRials ?? ''}" placeholder="قیمت ریالی" title="قیمت ریالی">
    <input data-f="validityDays" type="number" min="0" dir="ltr" value="${p.validityDays ?? ''}" placeholder="اعتبار (روز)" title="روزهای اعتبار — خالی = بدون انقضا">
    <input data-f="badge" value="${esc(p.badge || '')}" placeholder="برچسب">
    <button class="ghost" data-del-pack="${i}">✕</button></div>`).join('');
  $$('#packs-editor [data-del-pack]').forEach((b) => b.addEventListener('click', () => { collectPacks(); settings.packs.splice(Number(b.dataset.delPack), 1); renderPacks(); }));
}
function collectPacks() {
  settings.packs = $$('#packs-editor [data-pack]').map((row) => ({
    id: $('[data-f=id]', row).value, title: $('[data-f=title]', row).value,
    usd: Number($('[data-f=usd]', row).value), priceRials: $('[data-f=priceRials]', row).value === '' ? null : Number($('[data-f=priceRials]', row).value),
    validityDays: $('[data-f=validityDays]', row).value === '' ? null : Number($('[data-f=validityDays]', row).value),
    badge: $('[data-f=badge]', row).value || null,
  }));
}
$('#pack-add').addEventListener('click', () => { collectPacks(); settings.packs.push({ id: 'pack-' + (settings.packs.length + 1), title: '', usd: 1, priceRials: null, validityDays: null, badge: null }); renderPacks(); });
$('#packs-save').addEventListener('click', async () => {
  try { collectPacks(); await api('/admin-api/settings/packs', { method: 'PUT', body: { packs: settings.packs } }); $('#packs-msg').textContent = 'ذخیره شد.'; await loadSettings(); }
  catch (e) { $('#packs-msg').textContent = e.message; }
});
function renderModels() {
  $('#models-editor').innerHTML = settings.models.map((m, i) => `<div class="editor-row models" data-model="${i}">
    <input data-f="model" dir="ltr" value="${esc(m.model)}" placeholder="نام مدل">
    <input data-f="multiplier" type="number" step="0.01" min="0" dir="ltr" value="${m.multiplier}" placeholder="ضریب">
    <button class="ghost" data-del-model="${i}">✕</button></div>`).join('');
  $$('#models-editor [data-del-model]').forEach((b) => b.addEventListener('click', () => { collectModels(); settings.models.splice(Number(b.dataset.delModel), 1); renderModels(); }));
}
function collectModels() {
  settings.models = $$('#models-editor [data-model]').map((row) => ({ model: $('[data-f=model]', row).value, multiplier: Number($('[data-f=multiplier]', row).value) }));
}
$('#model-add').addEventListener('click', () => { collectModels(); settings.models.push({ model: '', multiplier: 1 }); renderModels(); });
$('#models-save').addEventListener('click', async () => {
  try { collectModels(); await api('/admin-api/settings/models', { method: 'PUT', body: { models: settings.models } }); $('#models-msg').textContent = 'ذخیره شد.'; }
  catch (e) { $('#models-msg').textContent = e.message; }
});
$('#card-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/admin-api/settings/card', { method: 'PUT', body: { number: $('#card-number').value, holder: $('#card-holder').value, bank: $('#card-bank').value } }); $('#card-msg').textContent = 'ذخیره شد.'; }
  catch (e2) { $('#card-msg').textContent = e2.message; }
});
$('#token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/admin-api/settings/token-config', { method: 'PUT', body: { tokensPerUsd: Number($('#cfg-per-usd').value), defaultMultiplier: Number($('#cfg-default-mult').value) } }); $('#token-msg').textContent = 'ذخیره شد.'; await loadSettings(); }
  catch (e2) { $('#token-msg').textContent = e2.message; }
});

// ── audit ────────────────────────────────────────────────────────────────
async function loadAudit() {
  const { audit } = await api('/admin-api/audit?limit=200');
  $('#audit-list').innerHTML = audit.length ? `<table><thead><tr><th>زمان</th><th>مدیر</th><th>اقدام</th><th>هدف</th><th>جزئیات</th></tr></thead><tbody>
    ${audit.map((a) => `<tr><td>${fmtDate(a.createdAt)}</td><td dir="ltr">${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.target || '')}</td><td>${esc(a.meta ? JSON.stringify(a.meta) : '')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">رکوردی نیست.</p>';
}

void restore();
