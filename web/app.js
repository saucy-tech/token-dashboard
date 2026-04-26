// app.js — router, state, fetch helpers
// PATCHED: added /limits route, /home + /limits to RAIL_ROUTES, SSE home-strip refresh

import {
  currentWeekWindow,
  hourlyLimitSummary,
  limitForProvider,
  loadUsageSettings,
  progressPct,
  rollingHourWindow,
  sessionLimitSummary,
  weeklyLimitSummary,
} from '/web/limits.js';

export const $  = (sel, root=document) => root.querySelector(sel);
export const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const PROVIDER_IDENTITY = {
  all: { key: 'all', label: 'All providers', shortLabel: 'All', icon: 'ALL' },
  claude: { key: 'claude', label: 'Anthropic / Claude', shortLabel: 'Claude', icon: 'CC' },
  codex: { key: 'codex', label: 'OpenAI / Codex', shortLabel: 'OpenAI', icon: 'AI' },
  warp: { key: 'warp', label: 'Warp', shortLabel: 'Warp', icon: 'WP' },
  unknown: { key: 'unknown', label: 'Unknown', shortLabel: 'Unknown', icon: '--' },
};
const STATUS_WEIGHT = { ok: 0, caution: 1, near: 2, exceeded: 3 };

// PATCHED: added /home and /limits to RAIL_ROUTES
const RAIL_ROUTES = new Set(['/home', '/overview', '/sessions', '/prompts', '/limits']);

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
    const raw = String(p || '').toLowerCase();
    const meta = providerMeta(raw);
    if (meta.key !== 'unknown' || !raw) return meta.label;
    return raw[0].toUpperCase() + raw.slice(1);
  },
  sessionShort: s => {
    const raw = (s || '').includes(':') ? s.split(':').slice(1).join(':') : (s || '');
    return raw.slice(0, 8) + (raw.length > 8 ? '…' : '');
  },
  ts: t => (t || '').slice(0, 16).replace('T', ' '),
};

export async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 503) throw new Error('Dashboard is busy (another scan running). Retry in a moment.');
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export async function optionalApi(path, fallback, opts) {
  const r = await fetch(path, opts);
  if (r.status === 404) return fallback;
  if (r.status === 503) throw new Error('Dashboard is busy (another scan running). Retry in a moment.');
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export const state = { plan: 'api', pricing: null };
export const PROVIDER_OPTIONS = [
  { key: 'all', label: 'All providers' },
  { key: 'claude', label: 'Anthropic / Claude' },
  { key: 'codex', label: 'OpenAI / Codex' },
];

export function providerMeta(providerKey) {
  const key = String(providerKey || '').toLowerCase();
  return PROVIDER_IDENTITY[key] || PROVIDER_IDENTITY.unknown;
}

export function providerBadge(providerKey, opts = {}) {
  const meta = providerMeta(providerKey);
  const className = fmt.providerClass(meta.key);
  const subtleClass = opts.subtle ? ' subtle' : '';
  const label = opts.short ? meta.shortLabel : meta.label;
  return `<span class="badge provider-badge ${className}${subtleClass}"><span class="provider-glyph">${meta.icon}</span>${fmt.htmlSafe(label)}</span>`;
}

export function currentHashPath() {
  return (location.hash.replace(/^#/, '').split('?')[0]) || '/overview';
}

export function readHashParam(key, fallback = null) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  return params.get(key) ?? fallback;
}

export function readQuery(key, def = '') {
  const v = readHashParam(key, null);
  return v == null || v === '' ? def : v;
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
          <span class="provider-tab-chip ${fmt.providerClass(p.key)}">
            <span class="provider-glyph">${providerMeta(p.key).icon}</span>
            <span>${providerMeta(p.key).label}</span>
          </span>
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
  let body = 'Enabled source folders have logs and cached sessions. This panel reflects local cache health, not provider cloud-sync completeness.';
  if (cachedOnly.length) {
    body = 'Some sources are unavailable now, so totals may include cached data from earlier scans and miss newer local history. This is local cache state only.';
  } else if (partial.length) {
    body = 'Some enabled sources are missing, empty, or not cached yet. Dashboard totals are partial until those sources scan successfully. This does not validate cloud-side history.';
  } else if (sources.some(s => s.status === 'disabled')) {
    body = 'Only enabled local sources are scanned. Disabled providers are excluded unless their older cached rows are still in the database. Source status is local-cache only.';
  }
  const skipWarning = (status?.skipped_records > 0)
    ? `<div class="source-skip-warning">&#9888; ${fmt.int(status.skipped_records)} record${status.skipped_records === 1 ? '' : 's'} skipped last scan — see scan_errors.log${status.last_scan_error ? `: ${fmt.htmlSafe(status.last_scan_error)}` : ''}</div>`
    : '';
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
      ${skipWarning}
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

// PATCHED: added /limits route
const ROUTES = {
  '/home': () => import('/web/routes/home.js'),
  '/overview': () => import('/web/routes/overview.js'),
  '/comparison': () => import('/web/routes/comparison.js'),
  '/prompts':  () => import('/web/routes/prompts.js'),
  '/sessions': () => import('/web/routes/sessions.js'),
  '/projects': () => import('/web/routes/projects.js'),
  '/projects/:slug': () => import('/web/routes/project-detail.js'),
  '/skills':   () => import('/web/routes/skills.js'),
  '/tips':     () => import('/web/routes/tips.js'),
  '/limits':   () => import('/web/routes/limits.js'),
  '/settings': () => import('/web/routes/settings.js'),
};

function buildTopbar() {
  const wrap = document.createElement('header');
  wrap.className = 'topbar';
  wrap.innerHTML = `
    <div class="brand">Agent Dashboard</div>
    <nav>
      ${Object.keys(ROUTES).filter(p => !p.includes(':')).map(p => `<a href="#${p}" data-route="${p}">${p.slice(1)}</a>`).join('')}
    </nav>
    <div class="spacer"></div>
    <span class="pill" id="plan-pill">api</span>
    <span class="pill muted" title="Cmd/Ctrl+B blurs sensitive text">⌘B blur</span>
  `;
  document.body.prepend(wrap);
  const rail = document.createElement('section');
  rail.id = 'limit-rail';
  rail.className = 'limit-rail limit-rail-hidden';
  document.body.insertBefore(rail, document.getElementById('app'));
}

function setActiveTab(routeKey) {
  $$('header.topbar nav a').forEach(a => a.classList.toggle('active', a.dataset.route === routeKey));
}

let _rendering = false;
let _sseTimer = null;

async function render() {
  _rendering = true;
  let routeKey = '/overview';
  try {
    let hash = location.hash.replace(/^#/, '') || '/home';
    const bare = hash.split('?')[0];
    if (bare === '/claude') {
      location.hash = '#/overview?provider=claude';
      return;
    }
    if (bare === '/codex') {
      location.hash = '#/overview?provider=codex';
      return;
    }
    hash = location.hash.replace(/^#/, '') || '/home';
    const path = hash.split('?')[0];
    routeKey = path;
    if (path.startsWith('/sessions/')) routeKey = '/sessions';
    if (path.startsWith('/projects/')) routeKey = '/projects/:slug';
    setActiveTab(routeKey === '/projects/:slug' ? '/projects' : routeKey);
    const loader = ROUTES[routeKey] || ROUTES['/home'];
    const mod = await loader();
    $('#app').innerHTML = '';
    try {
      await mod.default($('#app'));
    } catch (e) {
      $('#app').innerHTML = `<div class="card"><h2>Error</h2><pre>${fmt.htmlSafe(String(e.stack || e))}</pre></div>`;
    }
    await renderLimitRail(routeKey);
  } catch (e) {
    console.warn('render failed', e);
  } finally {
    _rendering = false;
  }
}

function railStatusClass(status) {
  if (!status || status.pct == null) return 'ok';
  if (status.cls === 'exceeded') return 'exceeded';
  if (status.cls === 'near') return 'near';
  if (status.cls === 'caution') return 'caution';
  return 'ok';
}

function railSeverity(sessionStatus, hourlyStatus, weeklyStatus) {
  const classes = [railStatusClass(sessionStatus), railStatusClass(hourlyStatus), railStatusClass(weeklyStatus)];
  return classes.reduce((best, current) => (
    STATUS_WEIGHT[current] > STATUS_WEIGHT[best] ? current : best
  ), 'ok');
}

function railPercent(status) {
  if (!status || status.pct == null) return 'not set';
  return `${progressPct(status)}%`;
}

function railResetLabel(resetAt) {
  return resetAt.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// PATCHED: extended rail to render a compact limits strip on /home
async function renderLimitRail(routeKey) {
  const rail = $('#limit-rail');
  if (!rail) return;
  if (!RAIL_ROUTES.has(routeKey)) {
    rail.className = 'limit-rail limit-rail-hidden';
    rail.innerHTML = '';
    return;
  }

  // On /home, render a compact 3-metric limits strip instead of the full session rail
  if (routeKey === '/home') {
    await renderHomeLimitStrip(rail);
    return;
  }

  const provider = readProvider();
  const usageSettings = await loadUsageSettings(api);
  const limits = limitForProvider(usageSettings, provider.key);
  const hourWindow = rollingHourWindow(new Date());
  const weekWindow = currentWeekWindow(new Date(), limits.weekStartDay);
  const queryProvider = provider.key === 'all' ? null : provider.key;
  const [currentSession, currentHour, currentWeek] = await Promise.all([
    api(withQuery('/api/current-session', { provider: queryProvider })),
    api(withQuery('/api/overview', {
      since: hourWindow.start.toISOString(),
      until: hourWindow.end.toISOString(),
      provider: queryProvider,
    })),
    api(withQuery('/api/overview', {
      since: weekWindow.start.toISOString(),
      until: weekWindow.reset.toISOString(),
      provider: queryProvider,
    })),
  ]);
  const activeSession = currentSession.session || null;
  const sessionSummary = sessionLimitSummary(activeSession, limits);
  const hourlySummary = hourlyLimitSummary(currentHour, limits);
  const weeklySummary = weeklyLimitSummary(currentWeek, limits);
  const providerInfo = providerMeta(provider.key);
  const railClass = railSeverity(sessionSummary.status, hourlySummary.status, weeklySummary.status);
  const providerClass = fmt.providerClass(providerInfo.key);
  const sessionHref = activeSession
    ? '#/sessions/' + encodeURIComponent(activeSession.session_id) + (
      provider.key === 'all' ? '' : '?provider=' + encodeURIComponent(provider.key)
    )
    : '#/sessions' + (provider.key === 'all' ? '' : '?provider=' + encodeURIComponent(provider.key));
  const activityHint = activeSession
    ? (currentSession.freshness?.active ? 'active now' : 'latest scanned')
    : 'no scanned session';
  rail.className = `limit-rail status-${railClass} ${providerClass}`;
  rail.innerHTML = `
    <div class="limit-rail-inner">
      <div class="rail-provider ${providerClass}">
        <span class="provider-glyph">${providerInfo.icon}</span>
        <div>
          <div class="rail-label">Current provider</div>
          <div class="rail-value">${fmt.htmlSafe(providerInfo.label)}</div>
        </div>
      </div>
      <div class="rail-metric">
        <div class="rail-label">Active session billable</div>
        <div class="rail-value">${activeSession ? fmt.compact(sessionSummary.used) : '—'}</div>
        <div class="rail-sub">${fmt.htmlSafe(activityHint)}</div>
      </div>
      <div class="rail-metric">
        <div class="rail-label">Session limit</div>
        <div class="rail-value">${railPercent(sessionSummary.status)}</div>
      </div>
      <div class="rail-metric">
        <div class="rail-label">Hourly limit</div>
        <div class="rail-value">${railPercent(hourlySummary.status)}</div>
        <div class="rail-sub">${fmt.htmlSafe(fmt.compact(hourlySummary.used))} in rolling hour</div>
      </div>
      <div class="rail-metric">
        <div class="rail-label">Weekly limit</div>
        <div class="rail-value">${railPercent(weeklySummary.status)}</div>
      </div>
      <div class="rail-metric">
        <div class="rail-label">Reset time</div>
        <div class="rail-value">${fmt.htmlSafe(railResetLabel(weekWindow.reset))}</div>
      </div>
      <div class="rail-links">
        <a href="${sessionHref}">${activeSession ? 'Open active session' : 'View sessions'}</a>
        <a href="#/limits">Limits →</a>
        <a href="#/settings">Settings</a>
      </div>
    </div>`;
}

// PATCHED: compact limits strip for /home (CodexBar MetricRow style)
async function renderHomeLimitStrip(rail) {
  try {
    const usageSettings = await loadUsageSettings(api);
    const limits = limitForProvider(usageSettings, 'all');
    const hourWindow = rollingHourWindow(new Date());
    const weekWindow = currentWeekWindow(new Date(), limits.weekStartDay);
    const [session, hourData, weekData] = await Promise.all([
      api('/api/current-session'),
      api(withQuery('/api/overview', { since: hourWindow.start.toISOString(), until: hourWindow.end.toISOString() })),
      api(withQuery('/api/overview', { since: weekWindow.start.toISOString(), until: weekWindow.reset.toISOString() })),
    ]);
    const sessSummary  = sessionLimitSummary(session.session || null, limits);
    const hourSummary  = hourlyLimitSummary(hourData, limits);
    const weekSummary  = weeklyLimitSummary(weekData, limits);
    const showUsed     = localStorage.getItem('td.limits-show-used') !== '0';

    function metricCell(label, summary, resetLabel, color) {
      const pct = progressPct(summary.status);
      const statCls = summary.status.cls || 'normal';
      const statColor = statCls === 'exceeded' ? 'var(--bad)' : statCls === 'near' ? 'var(--warn)' : color;
      const pctLabel = showUsed ? `${pct}% used` : `${100 - pct}% left`;
      return `
        <div class="home-limit-cell">
          <div class="home-limit-label">${label}</div>
          <div class="home-limit-bar">
            <div class="home-limit-fill" style="width:${pct}%;background:${statColor};"></div>
          </div>
          <div class="home-limit-detail">
            <span style="color:${statColor};font-weight:600;">${pctLabel}</span>
            <span class="home-limit-reset">${fmt.htmlSafe(resetLabel)}</span>
          </div>
        </div>`;
    }

    const now = new Date();
    const nextHour = new Date(now); nextHour.setMinutes(0,0,0); nextHour.setHours(nextHour.getHours()+1);
    const daysToMon = (8-now.getDay())%7||7;
    const nextMon = new Date(now); nextMon.setDate(nextMon.getDate()+daysToMon); nextMon.setHours(0,0,0,0);
    const hmsMs = nextHour - now;
    const mm = String(Math.floor((hmsMs%3600000)/60000)).padStart(2,'0');
    const ss = String(Math.floor((hmsMs%60000)/1000)).padStart(2,'0');
    const wd = Math.floor((nextMon-now)/86400000);
    const wh = Math.floor(((nextMon-now)%86400000)/3600000);

    rail.className = `limit-rail home-limit-rail`;
    rail.innerHTML = `
      <div class="home-limit-strip">
        ${limits.sessionTokens ? metricCell('Session', sessSummary, 'ends w/ session', '#3FB68B') : ''}
        ${limits.hourlyTokens  ? metricCell('Hourly',  hourSummary,  `↺ ${mm}:${ss}`,           '#E8A23B') : ''}
        ${limits.weeklyTokens  ? metricCell('Weekly',  weekSummary,  `↺ ${wd}d ${wh}h`,         '#4A9EFF') : ''}
        <div class="home-limit-cell home-limit-links">
          <a href="#/limits" style="color:var(--accent);font-size:12px;">Full limits →</a>
          <a href="#/settings" style="color:var(--muted);font-size:11px;">Configure</a>
        </div>
      </div>`;
  } catch {
    rail.className = 'limit-rail limit-rail-hidden';
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

  // PATCHED: SSE — on scan, refresh limit rail without full page reload when possible
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = ev => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type !== 'scan') return;
        if (_sseTimer) clearTimeout(_sseTimer);
        _sseTimer = setTimeout(async () => {
          _sseTimer = null;
          if (_rendering) return;
          const routeKey = currentHashPath().startsWith('/sessions/') ? '/sessions'
            : currentHashPath().startsWith('/projects/') ? '/projects/:slug'
            : currentHashPath();
          // Refresh limit rail silently on all RAIL_ROUTES without a full re-render
          if (RAIL_ROUTES.has(routeKey)) {
            await renderLimitRail(routeKey).catch(() => {});
          }
          // Full re-render only on non-limits routes (limits route manages its own refresh)
          if (routeKey !== '/limits') {
            render();
          }
        }, 2000);
      } catch {}
    };
  } catch {}
}

boot();
