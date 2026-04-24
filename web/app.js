// app.js — router, state, fetch helpers

export const $  = (sel, root=document) => root.querySelector(sel);
export const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const fmt = {
  int:   n => (n ?? 0).toLocaleString(),
  compact: n => COMPACT.format(n ?? 0),
  usd:   n => n == null ? '—' : '$' + Number(n).toFixed(2),
  usd4:  n => n == null ? '—' : '$' + Number(n).toFixed(4),
  pct:   n => n == null ? '—' : (n * 100).toFixed(0) + '%',
  short: (s, n=80) => s == null ? '' : (s.length > n ? s.slice(0, n - 1) + '…' : s),
  htmlSafe: s => (s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  modelClass: m => {
    const s = (m || '').toLowerCase();
    if (s.includes('opus'))   return 'opus';
    if (s.includes('sonnet')) return 'sonnet';
    if (s.includes('haiku'))  return 'haiku';
    return '';
  },
  modelShort: m => (m || '').replace('claude-', ''),
  providerClass: p => {
    const s = (p || '').toLowerCase();
    if (s === 'claude') return 'provider-claude';
    if (s === 'codex')  return 'provider-codex';
    if (s === 'warp')   return 'provider-warp';
    return '';
  },
  providerLabel: p => {
    const s = (p || '').toLowerCase();
    if (!s) return 'Unknown';
    return s[0].toUpperCase() + s.slice(1);
  },
  sessionShort: s => {
    const raw = (s || '').includes(':') ? s.split(':').slice(1).join(':') : (s || '');
    return raw.slice(0, 8) + (raw.length > 8 ? '…' : '');
  },
  ts: t => (t || '').slice(0, 16).replace('T', ' '),
};

export async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export async function optionalApi(path, fallback, opts) {
  const r = await fetch(path, opts);
  if (r.status === 404) return fallback;
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export const state = { plan: 'api', pricing: null };
export const PROVIDER_OPTIONS = [
  { key: 'all', label: 'All providers' },
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'warp', label: 'Warp' },
];

export function currentHashPath() {
  return (location.hash.replace(/^#/, '').split('?')[0]) || '/overview';
}

export function readHashParam(key, fallback = null) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  return params.get(key) ?? fallback;
}

export function writeHashParams(updates, base = currentHashPath()) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  Object.entries(updates).forEach(([key, value]) => {
    if (value == null || value === '') params.delete(key);
    else params.set(key, value);
  });
  const query = params.toString();
  location.hash = '#' + base + (query ? '?' + query : '');
}

export function readProvider() {
  const key = (readHashParam('provider', 'all') || 'all').toLowerCase();
  return PROVIDER_OPTIONS.find(p => p.key === key) || PROVIDER_OPTIONS[0];
}

export function providerTabs(activeKey) {
  return `
    <div class="range-tabs provider-tabs" role="tablist">
      ${PROVIDER_OPTIONS.map(p => `
        <button data-provider="${p.key}" class="${p.key === activeKey ? 'active' : ''}">
          ${p.label}
        </button>`).join('')}
    </div>`;
}

export function dataSourcePanel(status, opts = {}) {
  const sources = Array.isArray(status?.sources) ? status.sources : [];
  if (!sources.length) return '';
  const partial = sources.filter(s => !['ready', 'disabled'].includes(s.data_state || ''));
  const cachedOnly = sources.filter(s => ['cached_missing', 'cached_disabled', 'cached_no_logs'].includes(s.data_state || ''));
  const waiting = sources.filter(s => ['not_scanned', 'scanned_empty'].includes(s.data_state || ''));
  const title = partial.length || cachedOnly.length || waiting.length ? 'Data coverage' : 'Data sources';
  let body = 'Enabled source folders have logs and cached sessions. Totals still reflect only supported local logs.';
  if (cachedOnly.length) {
    body = 'Some sources are unavailable now, so totals may include cached data from earlier scans and miss newer local history.';
  } else if (partial.length) {
    body = 'Some enabled sources are missing, empty, or not cached yet. Dashboard totals are partial until those sources scan successfully.';
  } else if (sources.some(s => s.status === 'disabled')) {
    body = 'Only enabled local sources are scanned. Disabled providers are excluded unless their older cached rows are still in the database.';
  }
  const compactClass = opts.compact ? ' source-panel-compact' : '';
  return `
    <div class="card source-panel${compactClass}">
      <div class="source-panel-head">
        <div>
          <h3>${title}</h3>
          <p class="muted">${body}</p>
        </div>
        ${opts.scanButton ? '<button class="ghost" data-scan-now>Scan now</button>' : ''}
      </div>
      <div class="source-grid">
        ${sources.map(sourceCard).join('')}
      </div>
    </div>`;
}

function sourceCard(s) {
  const statusLabel = {
    ready: 'Ready',
    not_scanned: 'Not cached',
    scanned_empty: 'No cached data',
    cached_missing: 'Cached only',
    cached_disabled: 'Cached only',
    cached_no_logs: 'Cached only',
  }[s.data_state] || {
    connected: 'Connected',
    empty: 'No logs yet',
    missing: 'Missing',
    disabled: 'Disabled',
  }[s.status] || fmt.providerLabel(s.status);
  const detail = sourceDetail(s);
  return `
    <div class="source-card source-${fmt.htmlSafe(s.status || 'unknown')} source-state-${fmt.htmlSafe(s.data_state || 'unknown')}">
      <div class="source-title">
        <span>${fmt.htmlSafe(s.label || fmt.providerLabel(s.provider))}</span>
        <span class="badge ${fmt.providerClass(s.provider)}">${fmt.htmlSafe(statusLabel)}</span>
      </div>
      <div class="source-path" title="${fmt.htmlSafe(s.path || '')}">${fmt.htmlSafe(s.path || 'not configured')}</div>
      <div class="source-detail">${detail}</div>
    </div>`;
}

function sourceDetail(s) {
  const sessions = fmt.int(s.cached_sessions) + ' cached session' + (s.cached_sessions === 1 ? '' : 's');
  const messages = fmt.int(s.cached_messages) + ' cached message' + (s.cached_messages === 1 ? '' : 's');
  const logs = fmt.int(s.log_files) + ' log file' + (s.log_files === 1 ? '' : 's');
  const scanned = fmt.int(s.scanned_files) + ' scanned file' + (s.scanned_files === 1 ? '' : 's');
  if (s.data_state === 'cached_disabled') return `${sessions}; scanning disabled for this run.`;
  if (s.data_state === 'cached_missing') return `${sessions}; source path is missing, so this may be stale.`;
  if (s.data_state === 'cached_no_logs') return `${sessions}; source folder has no logs now.`;
  if (s.status === 'disabled') return fmt.htmlSafe(s.hint || 'Disabled for this run.');
  if (s.status === 'missing') return fmt.htmlSafe(s.hint || 'Folder not found.');
  if (s.status === 'empty') return 'Folder found, but no supported session logs were found yet.';
  if (s.data_state === 'not_scanned') return `${logs}; not cached yet. Use Scan now.`;
  if (s.data_state === 'scanned_empty') return `${logs} · ${scanned}; no supported sessions cached yet.`;
  return `${logs} · ${scanned} · ${sessions} · ${messages}`;
}

export function withQuery(url, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === '' || value === 'all') return;
    query.set(key, value);
  });
  const qs = query.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

export function exportHref(name, format, params = {}) {
  return withQuery(`/api/export/${name}.${format}`, params);
}

const ROUTES = {
  '/overview': () => import('/web/routes/overview.js'),
  '/comparison': () => import('/web/routes/comparison.js'),
  '/prompts':  () => import('/web/routes/prompts.js'),
  '/sessions': () => import('/web/routes/sessions.js'),
  '/projects': () => import('/web/routes/projects.js'),
  '/skills':   () => import('/web/routes/skills.js'),
  '/tips':     () => import('/web/routes/tips.js'),
  '/settings': () => import('/web/routes/settings.js'),
};

function buildTopbar() {
  const wrap = document.createElement('header');
  wrap.className = 'topbar';
  wrap.innerHTML = `
    <div class="brand">Agent Dashboard</div>
    <nav>
      ${Object.keys(ROUTES).map(p => `<a href="#${p}" data-route="${p}">${p.slice(1)}</a>`).join('')}
    </nav>
    <div class="spacer"></div>
    <span class="pill" id="plan-pill">api</span>
    <span class="pill muted" title="Cmd/Ctrl+B blurs sensitive text">⌘B blur</span>
  `;
  document.body.prepend(wrap);
}

function setActiveTab(routeKey) {
  $$('header.topbar nav a').forEach(a => a.classList.toggle('active', a.dataset.route === routeKey));
}

let _rendering = false;
let _sseTimer = null;

async function render() {
  _rendering = true;
  try {
    const hash = location.hash.replace(/^#/, '') || '/overview';
    const path = hash.split('?')[0];
    let key = path;
    if (path.startsWith('/sessions/')) key = '/sessions';
    setActiveTab(key);
    const loader = ROUTES[key] || ROUTES['/overview'];
    const mod = await loader();
    $('#app').innerHTML = '';
    try {
      await mod.default($('#app'));
    } catch (e) {
      $('#app').innerHTML = `<div class="card"><h2>Error</h2><pre>${fmt.htmlSafe(String(e.stack || e))}</pre></div>`;
    }
  } finally {
    _rendering = false;
  }
}

async function firstRun() {
  if (localStorage.getItem('td.plan-set')) return;
  const plans = Object.entries(state.pricing.plans);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Welcome — pick your plan</h2>
      <p>This labels API-equivalent token estimates with your subscription context. Change it later in Settings.</p>
      <select id="firstplan" style="width:100%">
        ${plans.map(([k,v]) => `<option value="${k}">${v.label}${v.monthly ? ` — $${v.monthly}/mo` : ''}</option>`).join('')}
      </select>
      <div class="actions">
        <div class="spacer"></div>
        <button class="primary" id="firstsave">Continue</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  await new Promise(res => $('#firstsave', overlay).addEventListener('click', async () => {
    const plan = $('#firstplan', overlay).value;
    await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
    localStorage.setItem('td.plan-set', '1');
    overlay.remove();
    res();
  }));
  state.plan = (await api('/api/plan')).plan;
}

async function boot() {
  buildTopbar();
  const planResp = await api('/api/plan');
  state.plan = planResp.plan;
  state.pricing = planResp.pricing;
  $('#plan-pill').textContent = state.plan;

  await firstRun();

  window.addEventListener('hashchange', render);
  await render();

  // Privacy blur (Cmd+B / Ctrl+B)
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      document.body.classList.toggle('privacy-on');
    }
  });

  // SSE diff stream — debounced 2 s to avoid thrashing on rapid scans
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = ev => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type !== 'scan') return;
        if (_sseTimer) clearTimeout(_sseTimer);
        _sseTimer = setTimeout(() => {
          _sseTimer = null;
          if (!_rendering) render();
        }, 2000);
      } catch {}
    };
  } catch {}
}

boot();
