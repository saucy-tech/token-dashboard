// web/routes/sessions.js — PATCHED: inline side drawer on row click (no page reload)
import {
  api,
  currentHashPath,
  exportHref,
  fmt,
  providerBadge,
  providerTabs,
  readHashParam,
  readProvider,
  withQuery,
  writeHashParams,
} from '/web/app.js';
import { limitForProvider, loadUsageSettings, sessionLimitSummary } from '/web/limits.js';

const RANGES = [
  { key: '7d',  label: '7d',  days: 7  },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: 'All', days: null },
];
const RISK_FILTERS = [
  { key: 'all',      label: 'All risk states' },
  { key: 'near',     label: 'Near limit'      },
  { key: 'exceeded', label: 'Exceeded'        },
];
const SORTS = [
  { key: 'recent', label: 'Most recent'  },
  { key: 'risk',   label: 'Highest risk' },
  { key: 'tokens', label: 'Most tokens'  },
];
const PAGE_SIZE = 50;
let _page = 0;
let _sessionsScopeKey = '';
let _drawerSessionId = null; // track open drawer session

export default async function (root) {
  const id = decodeURIComponent(currentHashPath().split('/')[2] || '');
  if (!id) return renderList(root);
  return renderSession(root, id);
}

// ── LIST VIEW ──────────────────────────────────────────────────────────────────
async function renderList(root) {
  const provider    = readProvider();
  const range       = readRange();
  const riskFilter  = readRiskFilter();
  const sort        = readSort();
  const since       = sinceIso(range);
  const until       = untilIso(range);
  const scopeKey    = `${provider.key}|${range.key}|${riskFilter.key}|${sort.key}`;
  if (scopeKey !== _sessionsScopeKey) { _sessionsScopeKey = scopeKey; _page = 0; }

  const exportParams = { limit: 1000, since, until, provider: provider.key === 'all' ? null : provider.key };
  const [settings, list] = await Promise.all([
    loadUsageSettings(api),
    api(withQuery('/api/sessions', { limit: PAGE_SIZE, offset: 0, since, until, provider: provider.key === 'all' ? null : provider.key })),
  ]);
  const rows = [...list];
  const selectedProvider = provider.key === 'all' ? 'all providers' : fmt.providerLabel(provider.key);

  const rangeTabs = `<div class="range-tabs" role="tablist">
    ${RANGES.map(r => `<button data-range="${r.key}" class="${r.key === range.key ? 'active' : ''}">${r.label}</button>`).join('')}
  </div>`;
  const filterTabs = `<div class="range-tabs" role="tablist">
    ${RISK_FILTERS.map(f => `<button data-risk-filter="${f.key}" class="${riskFilter.key === f.key ? 'active' : ''}">${f.label}</button>`).join('')}
  </div>`;
  const sortTabs = `<div class="range-tabs" role="tablist">
    ${SORTS.map(s => `<button data-sort="${s.key}" class="${sort.key === s.key ? 'active' : ''}">${s.label}</button>`).join('')}
  </div>`;
  const hasMoreInitial = list.length === PAGE_SIZE;

  root.innerHTML = `
    <style>
      .sessions-layout { display: grid; gap: 14px; }
      .sessions-layout.drawer-open { grid-template-columns: 1fr 440px; align-items: start; }
      .sessions-drawer-panel {
        position: sticky; top: 100px; max-height: calc(100vh - 120px);
        overflow-y: auto; border-radius: 10px;
      }
      .sessions-drawer-panel::-webkit-scrollbar { width: 4px; }
      .sessions-drawer-panel::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 2px; }
      tr.session-row-clickable { cursor: pointer; }
      tr.session-row-clickable.drawer-selected { background: rgba(74,158,255,0.1) !important; }
    </style>

    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-.01em">Sessions</h2>
      <span class="muted" style="font-size:12px">${range.days ? `last ${range.days} days` : 'all time'} · ${fmt.htmlSafe(selectedProvider)}</span>
      <div class="spacer"></div>
      ${rangeTabs}
    </div>

    <div class="sessions-layout" id="sessions-layout">
      <!-- table -->
      <div>
        <div class="card">
          <div class="flex" style="margin:-8px 0 12px;align-items:flex-start">
            <p class="muted" style="margin:0">Click a row to inspect inline. Showing ${fmt.htmlSafe(selectedProvider)}.</p>
            <span class="spacer"></span>
            <div class="export-actions">
              <a href="${exportHref('sessions', 'csv', exportParams)}" class="button-link">Export CSV</a>
              <a href="${exportHref('sessions', 'json', exportParams)}" class="button-link">Export JSON</a>
            </div>
          </div>
          <div class="flex" style="margin:-4px 0 10px;justify-content:flex-end">
            ${providerTabs(provider.key)}
          </div>
          <div class="flex" style="margin:0 0 14px;justify-content:space-between;gap:12px;flex-wrap:wrap">
            ${filterTabs}
            ${sortTabs}
          </div>
          <table>
            <thead><tr>
              <th>started</th><th>project</th><th>provider</th><th>limit risk</th>
              <th class="num">turns</th><th class="num">tokens</th><th>session</th>
            </tr></thead>
            <tbody id="sessions-body"></tbody>
          </table>
          <div style="margin-top:12px">
            <button class="ghost" id="sessions-load-more" ${hasMoreInitial ? '' : 'hidden'}>Load 50 more</button>
          </div>
        </div>
      </div>
      <!-- drawer (hidden until row clicked) -->
      <div id="sessions-drawer" style="display:none;"></div>
    </div>`;

  const body   = root.querySelector('#sessions-body');
  const layout = root.querySelector('#sessions-layout');
  const drawer = root.querySelector('#sessions-drawer');

  // ── render + filter rows ──────────────────────────────────────────────────
  function renderRows() {
    const enriched = rows.map(s => {
      const lim  = limitForProvider(settings, s.provider || provider.key || 'all');
      const risk = sessionLimitSummary({ billable_tokens: s.tokens || 0 }, lim);
      return { ...s, limits: lim, risk };
    });
    const filtered = enriched.filter(row => {
      if (riskFilter.key === 'all')      return true;
      if (riskFilter.key === 'near')     return ['near','caution'].includes(row.risk.status.cls);
      return row.risk.status.cls === 'exceeded';
    });
    const sorted = [...filtered].sort((a, b) => compareRows(a, b, sort.key));
    body.innerHTML = sorted.length
      ? sorted.map(s => sessionRow(s, provider)).join('')
      : '<tr id="sessions-empty"><td colspan="7" class="muted">no sessions match this filter</td></tr>';

    // Re-highlight selected row if drawer is open
    if (_drawerSessionId) {
      body.querySelector(`tr[data-session-id="${CSS.escape(_drawerSessionId)}"]`)
        ?.classList.add('drawer-selected');
    }
  }
  renderRows();

  // ── inline drawer ─────────────────────────────────────────────────────────
  async function openDrawer(sessionId) {
    // Toggle off if already open for same session
    if (_drawerSessionId === sessionId) {
      closeDrawer();
      return;
    }
    _drawerSessionId = sessionId;

    // Highlight row
    body.querySelectorAll('tr.drawer-selected').forEach(r => r.classList.remove('drawer-selected'));
    body.querySelector(`tr[data-session-id="${CSS.escape(sessionId)}"]`)?.classList.add('drawer-selected');

    // Show loading state
    drawer.style.display = '';
    layout.classList.add('drawer-open');
    drawer.innerHTML = `
      <div class="card sessions-drawer-panel" style="padding:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <span style="font-weight:600;font-size:13px;">Session detail</span>
          <button id="drawer-close" class="ghost" style="padding:2px 8px;font-size:16px;line-height:1;">×</button>
        </div>
        <div style="color:var(--muted);font-size:12px;padding:32px 0;text-align:center;">Loading…</div>
      </div>`;
    drawer.querySelector('#drawer-close')?.addEventListener('click', closeDrawer);

    try {
      const turns = await api('/api/sessions/' + encodeURIComponent(sessionId));
      drawer.innerHTML = buildDrawerHtml(sessionId, turns, settings, provider);
      wireDrawer(drawer, turns, sessionId);
    } catch (e) {
      drawer.innerHTML = `
        <div class="card sessions-drawer-panel" style="padding:16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <span style="font-weight:600;font-size:13px;">Session detail</span>
            <button id="drawer-close" class="ghost" style="padding:2px 8px;font-size:16px;line-height:1;">×</button>
          </div>
          <div style="color:var(--bad);font-size:12px;">Failed to load: ${fmt.htmlSafe(String(e.message || e))}</div>
        </div>`;
      drawer.querySelector('#drawer-close')?.addEventListener('click', closeDrawer);
    }
  }

  function closeDrawer() {
    _drawerSessionId = null;
    drawer.style.display = 'none';
    drawer.innerHTML = '';
    layout.classList.remove('drawer-open');
    body.querySelectorAll('tr.drawer-selected').forEach(r => r.classList.remove('drawer-selected'));
  }

  // row click handler
  body.addEventListener('click', e => {
    const row = e.target.closest('tr[data-session-id]');
    if (!row) return;
    // If clicking the "open" link, let it navigate normally
    if (e.target.closest('a[data-open-full]')) return;
    openDrawer(row.dataset.sessionId);
  });

  // ── filter / sort / load-more ─────────────────────────────────────────────
  root.querySelectorAll('[data-provider],[data-range],[data-risk-filter],[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.provider)   { writeHashParams({ provider: btn.dataset.provider === 'all' ? null : btn.dataset.provider }); return; }
      if (btn.dataset.range)      { writeHashParams({ range: btn.dataset.range === '30d' ? null : btn.dataset.range }); return; }
      if (btn.dataset.riskFilter) { writeHashParams({ risk: btn.dataset.riskFilter === 'all' ? null : btn.dataset.riskFilter }); return; }
      if (btn.dataset.sort)       { writeHashParams({ sort: btn.dataset.sort === 'recent' ? null : btn.dataset.sort }); }
    });
  });

  root.querySelector('#sessions-load-more')?.addEventListener('click', async function() {
    _page += 1;
    const next = await api(withQuery('/api/sessions', {
      limit: PAGE_SIZE, offset: _page * PAGE_SIZE, since, until,
      provider: provider.key === 'all' ? null : provider.key,
    }));
    if (!next.length) { this.hidden = true; return; }
    rows.push(...next);
    renderRows();
    if (next.length < PAGE_SIZE) this.hidden = true;
  });
}

// ── drawer HTML builder ───────────────────────────────────────────────────────
function buildDrawerHtml(sessionId, turns, settings, provider) {
  let totalIn = 0, totalOut = 0, totalCacheRd = 0, totalCacheCreate = 0;
  for (const t of turns) {
    if (t.type !== 'assistant') continue;
    totalIn          += t.input_tokens || 0;
    totalOut         += t.output_tokens || 0;
    totalCacheRd     += t.cache_read_tokens || 0;
    totalCacheCreate += (t.cache_create_5m_tokens || 0) + (t.cache_create_1h_tokens || 0);
  }
  const billable  = totalIn + totalOut + totalCacheCreate;
  const slug      = (turns[0]?.project_slug) || '';
  const cwd       = (turns.find(t => t.cwd) || {}).cwd || '';
  const base      = cwd ? cwd.replace(/\\/g,'/').replace(/\/+$/,'').split('/').pop() : '';
  const project   = base || slug;
  const started   = turns[0]?.timestamp || '';
  const ended     = turns[turns.length - 1]?.timestamp || '';
  const provKey   = turns[0]?.provider || '';
  const lim       = limitForProvider(settings, provKey || 'all');
  const usage     = sessionLimitSummary({ billable_tokens: billable }, lim);
  const usagePct  = usage.status.pct == null ? 0 : usage.pct;
  const usageCls  = usage.status.cls === 'exceeded' ? 'over' : (['near','caution'].includes(usage.status.cls) ? 'near' : 'ok');
  const limitDelta = lim.sessionTokens == null ? null : lim.sessionTokens - billable;
  const deltaCopy  = limitDelta == null ? 'Set a session limit in Settings'
    : limitDelta < 0 ? `${fmt.compact(Math.abs(limitDelta))} over`
    : `${fmt.compact(limitDelta)} remaining`;
  const sessionLabel = turns[0]?.session_label || '';
  const fullHref  = '#/sessions/' + encodeURIComponent(sessionId) + (provider.key === 'all' ? '' : '?provider=' + encodeURIComponent(provider.key));

  return `
    <div class="card sessions-drawer-panel provider-surface ${fmt.providerClass(provKey)}">
      <!-- header -->
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">
          ${fmt.htmlSafe(sessionLabel || fmt.sessionShort(sessionId))}
        </span>
        ${provKey ? providerBadge(provKey) : ''}
        <a href="${fullHref}" data-open-full style="font-size:11px;color:var(--accent);white-space:nowrap;">Full page →</a>
        <button id="drawer-close" class="ghost" style="padding:2px 8px;font-size:16px;line-height:1;flex-shrink:0;">×</button>
      </div>

      <!-- meta row -->
      <div style="display:flex;flex-wrap:wrap;gap:10px;font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:12px;">
        <span>${fmt.htmlSafe(project)}</span>
        <span>${fmt.ts(started)} → ${fmt.ts(ended)}</span>
        <span>${fmt.int(turns.length)} records</span>
      </div>

      <!-- limit strip -->
      <div class="session-limit-strip ${usageCls}" style="margin-bottom:12px;">
        <div class="session-limit-main">
          <span class="session-limit-kicker">Limit risk</span>
          <strong>${fmt.compact(billable)}</strong>
          <span class="session-limit-status ${usageCls}">${fmt.htmlSafe(usage.status?.name || 'Not set')}</span>
          <span class="muted">billable tokens</span>
        </div>
        <div>
          <div class="session-limit-meter"><span style="width:${usagePct}%"></span></div>
          <div class="session-limit-meta">${lim.sessionTokens ? `${usagePct}% of ${fmt.compact(lim.sessionTokens)} limit` : 'No limit set'}</div>
        </div>
        <div class="session-limit-delta">
          <strong>${fmt.htmlSafe(deltaCopy)}</strong>
        </div>
      </div>

      <!-- cost breakdown -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
        ${[['Input', totalIn],['Output', totalOut],['Cache create', totalCacheCreate],['Cache read', totalCacheRd]].map(([l,v]) => `
          <div style="padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--muted);">${l}</div>
            <div style="font-family:var(--mono);font-size:14px;margin-top:2px;">${fmt.compact(v)}</div>
          </div>`).join('')}
      </div>

      <!-- turn table (compact) -->
      <h3 style="margin:0 0 8px;font-size:12px;">Turn-by-turn</h3>
      <table style="font-size:12px;">
        <thead><tr>
          <th>time</th><th>type</th><th>model</th>
          <th class="blur-sensitive">prompt / tools</th>
          <th class="num">in</th><th class="num">out</th><th></th>
        </tr></thead>
        <tbody id="drawer-turns">
          ${turns.map((t, i) => {
            const tools   = toolCalls(t);
            const toolUses = tools.filter(x => x.tool_name !== '_tool_result');
            const summary = t.prompt_text ? fmt.short(t.prompt_text, 60) : (toolUses.length ? toolUses.map(x => x.tool_name).join(' · ') : '');
            const hasDetail = Boolean(t.prompt_text || tools.length);
            return `<tr class="${hasDetail ? 'session-row-with-detail' : ''}" data-drawer-i="${i}">
              <td class="mono">${(t.timestamp||'').slice(11,16)}</td>
              <td>${t.type}</td>
              <td>${t.model ? `<span class="badge ${fmt.modelClass(t.model)}">${fmt.htmlSafe(fmt.modelShort(t.model))}</span>` : ''}</td>
              <td class="blur-sensitive" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${fmt.htmlSafe(summary)}</td>
              <td class="num">${fmt.int(t.input_tokens)}</td>
              <td class="num">${fmt.int(t.output_tokens)}</td>
              <td>${hasDetail ? `<button class="ghost drawer-detail-toggle" data-drawer-i="${i}" style="font-size:11px;padding:2px 6px;">+</button>` : ''}</td>
            </tr>
            ${hasDetail ? drawerDetailRow(t, i, tools) : ''}`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function wireDrawer(drawer, turns, sessionId) {
  drawer.querySelector('#drawer-close')?.addEventListener('click', () => {
    drawer.style.display = 'none';
    drawer.innerHTML = '';
    drawer.closest('.sessions-layout')?.classList.remove('drawer-open');
    document.querySelector(`tr[data-session-id="${CSS.escape(sessionId)}"]`)?.classList.remove('drawer-selected');
    _drawerSessionId = null;
  });

  drawer.querySelectorAll('.drawer-detail-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i   = btn.dataset.drawerI;
      const row = drawer.querySelector(`.drawer-detail-row[data-drawer-detail="${i}"]`);
      if (!row) return;
      row.hidden = !row.hidden;
      btn.textContent = row.hidden ? '+' : '−';
    });
  });

  drawer.querySelectorAll('.drawer-copy-prompt').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const t = turns[Number(btn.dataset.drawerI)];
      if (!t?.prompt_text) return;
      await navigator.clipboard.writeText(t.prompt_text).catch(() => {});
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
  });
}

function drawerDetailRow(turn, index, tools) {
  return `
    <tr class="drawer-detail-row session-detail-row" data-drawer-detail="${index}" hidden>
      <td colspan="7">
        <div class="session-detail">
          ${turn.prompt_text ? `
            <div class="session-detail-head">
              <strong>Prompt</strong>
              <button class="ghost drawer-copy-prompt" data-drawer-i="${index}" style="font-size:11px;">Copy</button>
            </div>
            <pre class="blur-sensitive">${fmt.htmlSafe(turn.prompt_text)}</pre>` : ''}
          ${tools.length ? `
            <div class="session-detail-head"><strong>Tool calls (${tools.length})</strong></div>
            <table class="tool-detail-table">
              <thead><tr><th>tool</th><th>target</th><th class="num">result tokens</th><th>status</th></tr></thead>
              <tbody>
                ${tools.map(tool => `
                  <tr>
                    <td><span class="badge">${fmt.htmlSafe(tool.tool_name || 'tool')}</span></td>
                    <td class="blur-sensitive">${fmt.htmlSafe(fmt.short(tool.target || '', 80))}</td>
                    <td class="num">${tool.result_tokens == null ? '—' : fmt.int(tool.result_tokens)}</td>
                    <td>${tool.is_error ? '<span class="badge tool-error">error</span>' : '<span class="badge tool-ok">ok</span>'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>` : ''}
        </div>
      </td>
    </tr>`;
}

// ── FULL SESSION PAGE (direct URL navigation) ─────────────────────────────────
async function renderSession(root, id) {
  const turns = await api('/api/sessions/' + encodeURIComponent(id));
  let totalIn = 0, totalOut = 0, totalCacheRd = 0, totalCacheCreate = 0;
  for (const t of turns) {
    if (t.type !== 'assistant') continue;
    totalIn          += t.input_tokens || 0;
    totalOut         += t.output_tokens || 0;
    totalCacheRd     += t.cache_read_tokens || 0;
    totalCacheCreate += (t.cache_create_5m_tokens || 0) + (t.cache_create_1h_tokens || 0);
  }
  const billable    = totalIn + totalOut + totalCacheCreate;
  const slug        = (turns[0]?.project_slug) || '';
  const cwd         = (turns.find(t => t.cwd) || {}).cwd || '';
  const base        = cwd ? cwd.replace(/\\/g,'/').replace(/\/+$/,'').split('/').pop() : '';
  const project     = base || slug;
  const started     = turns[0]?.timestamp || '';
  const ended       = turns[turns.length-1]?.timestamp || '';
  const provider    = turns[0]?.provider || '';
  const settings    = await loadUsageSettings(api);
  const lim         = limitForProvider(settings, provider || 'all');
  const usage       = sessionLimitSummary({ billable_tokens: billable }, lim);
  const usagePct    = usage.status.pct == null ? 0 : usage.pct;
  const usageCls    = usage.status.cls === 'exceeded' ? 'over'
    : (['near','caution'].includes(usage.status.cls) ? 'near' : (usage.status.cls === 'normal' ? 'ok' : ''));
  const limitDelta  = lim.sessionTokens == null ? null : lim.sessionTokens - billable;
  const deltaCopy   = limitDelta == null ? 'Set a session limit in Settings'
    : limitDelta < 0 ? `${fmt.compact(Math.abs(limitDelta))} over`
    : `${fmt.compact(limitDelta)} remaining`;
  const sourceCopy  = !lim.sessionTokens ? 'Threshold source: not configured'
    : `Threshold source: ${lim.sessionProviderOverride ? `${fmt.providerLabel(provider)} session override` : 'global default'}`;
  const sessionLabel = turns[0]?.session_label || '';
  const backProvider = readProvider();
  const backHref    = backProvider.key === 'all' ? '#/sessions' : '#/sessions?provider=' + encodeURIComponent(backProvider.key);

  root.innerHTML = `
    <div class="card provider-surface ${fmt.providerClass(provider)}">
      <h2 style="display:flex;align-items:center">
        <span>${fmt.htmlSafe(sessionLabel || ('Session ' + fmt.sessionShort(id)))}</span>
        <span class="spacer"></span>
        ${provider ? providerBadge(provider) : ''}
        <a href="${backHref}" class="muted">← all sessions</a>
      </h2>
      <div class="flex muted" style="font-family:var(--mono);font-size:12px;flex-wrap:wrap;gap:14px">
        <span>${fmt.htmlSafe(project)}</span>
        <span>${fmt.ts(started)} → ${fmt.ts(ended)}</span>
        <span>${fmt.sessionShort(id)}</span>
        <span>${turns.length} records</span>
        <span>${fmt.int(totalIn)} in · ${fmt.int(totalOut)} out · ${fmt.int(totalCacheRd)} cache rd</span>
      </div>
      <div class="session-limit-strip ${usageCls}">
        <div class="session-limit-main">
          <span class="session-limit-kicker">Limit risk</span>
          <strong>${fmt.compact(billable)}</strong>
          <span class="session-limit-status ${usageCls}">${fmt.htmlSafe(usage.status?.name || 'Not set')}</span>
          <span class="muted">billable tokens</span>
        </div>
        <div>
          <div class="session-limit-meter" aria-label="session limit usage">
            <span style="width:${usagePct}%"></span>
          </div>
          <div class="session-limit-meta">${lim.sessionTokens ? `${usagePct}% of ${fmt.compact(lim.sessionTokens)} limit` : 'No limit set'}</div>
        </div>
        <div class="session-limit-delta">
          <strong>${fmt.htmlSafe(deltaCopy)}</strong>
          <span class="muted">${fmt.htmlSafe(sourceCopy)}</span>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Turn-by-turn</h3>
      <table>
        <thead><tr><th>time</th><th>type</th><th>model</th><th class="blur-sensitive">prompt / tools</th>
          <th class="num">in</th><th class="num">out</th><th class="num">cache rd</th><th></th></tr></thead>
        <tbody>
          ${turns.map((t, i) => {
            const tools    = toolCalls(t);
            const toolUses = tools.filter(x => x.tool_name !== '_tool_result');
            const summary  = t.prompt_text ? fmt.short(t.prompt_text, 110) : (toolUses.length ? toolUses.map(x => x.tool_name).join(' · ') : '');
            const hasDetail = Boolean(t.prompt_text || tools.length);
            return `<tr class="${hasDetail ? 'session-row-with-detail' : ''}" data-i="${i}">
              <td class="mono">${(t.timestamp||'').slice(11,19)}</td>
              <td>${t.type}${t.is_sidechain ? ' <span class="badge">side</span>' : ''}</td>
              <td>${t.model ? `<span class="badge ${fmt.modelClass(t.model)}">${fmt.htmlSafe(fmt.modelShort(t.model))}</span>` : ''}</td>
              <td class="blur-sensitive">${fmt.htmlSafe(summary)}</td>
              <td class="num">${fmt.int(t.input_tokens)}</td>
              <td class="num">${fmt.int(t.output_tokens)}</td>
              <td class="num">${fmt.int(t.cache_read_tokens)}</td>
              <td class="num">${hasDetail ? `<button class="ghost detail-toggle" data-i="${i}">Details</button>` : ''}</td>
            </tr>
            ${hasDetail ? detailRow(t, i, tools) : ''}`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  root.querySelectorAll('.detail-toggle').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); toggleDetail(root, btn.dataset.i); });
  });
  root.querySelectorAll('.session-row-with-detail').forEach(row => {
    row.addEventListener('click', () => toggleDetail(root, row.dataset.i));
  });
  root.querySelectorAll('.copy-prompt').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const text = turns[Number(btn.dataset.i)]?.prompt_text || '';
      await navigator.clipboard.writeText(text).catch(() => {});
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy prompt'; }, 1200);
    });
  });
}

// ── shared helpers ────────────────────────────────────────────────────────────
function readRange() {
  const key = readHashParam('range');
  return RANGES.find(r => r.key === key) || RANGES[1];
}
function sinceIso(range) {
  if (!range.days) return null;
  return new Date(Date.now() - range.days * 86400 * 1000).toISOString();
}
function untilIso(range) {
  return range.days ? new Date().toISOString() : null;
}
function readRiskFilter() {
  const key = (readHashParam('risk') || 'all').toLowerCase();
  return RISK_FILTERS.find(r => r.key === key) || RISK_FILTERS[0];
}
function readSort() {
  const key = (readHashParam('sort') || 'recent').toLowerCase();
  return SORTS.find(s => s.key === key) || SORTS[0];
}
function riskCell(risk) {
  const cls = riskClass(risk.status?.cls);
  const pct = risk.status?.pct == null ? 0 : risk.pct;
  return `<div class="risk-cell ${cls}">
    <div class="risk-label">${fmt.htmlSafe(risk.status?.name || 'Not set')}</div>
    <div class="risk-meter"><span style="width:${pct}%"></span></div>
    <div class="risk-sub">${risk.status?.pct == null ? 'set a session limit' : `${pct}% used`}</div>
  </div>`;
}
function riskClass(cls) {
  return { exceeded:'exceeded', near:'near', caution:'caution' }[cls] || 'normal';
}
function riskWeight(cls) {
  return { exceeded:3, near:2, caution:1 }[cls] || 0;
}
function compareRows(a, b, sortKey) {
  if (sortKey === 'tokens') return (b.tokens||0) - (a.tokens||0);
  if (sortKey === 'risk') {
    const d = riskWeight(b.risk.status?.cls) - riskWeight(a.risk.status?.cls);
    if (d) return d;
    const p = (b.risk.pct||0) - (a.risk.pct||0);
    if (p) return p;
    return (b.tokens||0) - (a.tokens||0);
  }
  return String(b.started||'').localeCompare(String(a.started||''));
}
function sessionHref(sessionId, provider) {
  return '#/sessions/' + encodeURIComponent(sessionId) + (provider.key === 'all' ? '' : '?provider=' + encodeURIComponent(provider.key));
}
function sessionRow(s, provider) {
  return `<tr class="provider-row session-row-clickable ${fmt.providerClass(s.provider)}" data-session-id="${fmt.htmlSafe(s.session_id)}">
    <td class="mono">${fmt.ts(s.started)}</td>
    <td title="${fmt.htmlSafe(s.project_slug)}">${fmt.htmlSafe(s.project_name || s.project_slug)}</td>
    <td>${providerBadge(s.provider)}</td>
    <td>${riskCell(s.risk)}</td>
    <td class="num">${fmt.int(s.turns)}</td>
    <td class="num">${fmt.int(s.tokens)}</td>
    <td><a href="${sessionHref(s.session_id, provider)}" data-open-full class="mono" onclick="event.stopPropagation()">${fmt.htmlSafe(fmt.sessionShort(s.session_id))}</a></td>
  </tr>`;
}
function toolCalls(turn) {
  if (Array.isArray(turn.tool_calls)) return turn.tool_calls;
  if (!turn.tool_calls_json) return [];
  try {
    return JSON.parse(turn.tool_calls_json).map(x => ({ tool_name:x.name, target:x.target, result_tokens:null, is_error:0, timestamp:turn.timestamp }));
  } catch { return []; }
}
function detailRow(turn, index, tools) {
  return `
    <tr class="session-detail-row" data-detail="${index}" hidden>
      <td colspan="8">
        <div class="session-detail">
          ${turn.prompt_text ? `
            <div class="session-detail-head">
              <strong>Prompt text</strong>
              <button class="ghost copy-prompt" data-i="${index}">Copy prompt</button>
            </div>
            <pre class="blur-sensitive">${fmt.htmlSafe(turn.prompt_text)}</pre>` : ''}
          ${tools.length ? `
            <div class="session-detail-head">
              <strong>Tool calls</strong>
              <span class="muted">${fmt.int(tools.length)} total</span>
            </div>
            <table class="tool-detail-table">
              <thead><tr><th>time</th><th>tool</th><th>target / id</th><th class="num">result tokens</th><th>status</th></tr></thead>
              <tbody>
                ${tools.map(tool => `
                  <tr>
                    <td class="mono">${(tool.timestamp||'').slice(11,19)}</td>
                    <td><span class="badge">${fmt.htmlSafe(tool.tool_name||'tool')}</span></td>
                    <td class="blur-sensitive">${fmt.htmlSafe(tool.target||'')}</td>
                    <td class="num">${tool.result_tokens==null?'—':fmt.int(tool.result_tokens)}</td>
                    <td>${tool.is_error?'<span class="badge tool-error">error</span>':'<span class="badge tool-ok">ok</span>'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>` : ''}
        </div>
      </td>
    </tr>`;
}
function toggleDetail(root, index) {
  const row = root.querySelector(`.session-detail-row[data-detail="${index}"]`);
  const btn = root.querySelector(`.detail-toggle[data-i="${index}"]`);
  if (!row) return;
  row.hidden = !row.hidden;
  if (btn) btn.textContent = row.hidden ? 'Details' : 'Hide';
}
