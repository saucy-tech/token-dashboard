// web/routes/home.js — PATCHED: combined cost hero + limits strip + provider split
import {
  api,
  dataSourcePanel,
  fmt,
  optionalApi,
  readHashParam,
  state,
  withQuery,
} from '/web/app.js';
import {
  currentWeekWindow,
  hourlyLimitSummary,
  limitForProvider,
  loadUsageSettings,
  rollingHourWindow,
  sessionLimitSummary,
  weeklyLimitSummary,
} from '/web/limits.js';

function sinceIsoDays(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}
function cacheCreate(t) {
  return (t.cache_create_5m_tokens || 0) + (t.cache_create_1h_tokens || 0);
}
function planSubtitle() {
  if (!state.pricing || state.plan === 'api') return '';
  const p = state.pricing.plans[state.plan];
  if (!p || !p.monthly) return '';
  return `<div class="sub">pay $${p.monthly}/mo on ${fmt.htmlSafe(p.label)}</div>`;
}

// ── combined cost hero ────────────────────────────────────────────────────────
function costHero(claudeT, codexT) {
  const claudeCost = claudeT.cost_usd || 0;
  const codexCost  = codexT.cost_usd  || 0;
  const total      = claudeCost + codexCost;

  const providerRow = (label, color, cost, provClass, icon) => {
    const share = total > 0 ? (cost / total) * 100 : 0;
    return `
      <div style="display:grid;grid-template-columns:80px 1fr 64px;align-items:center;gap:10px;">
        <span class="badge provider-badge ${provClass}" style="justify-self:start;">
          <span class="provider-glyph">${icon}</span>
          ${label}
        </span>
        <div style="height:5px;background:var(--bg);border-radius:999px;border:1px solid var(--border);overflow:hidden;">
          <div style="height:100%;width:${share.toFixed(1)}%;background:${color};border-radius:999px;transition:width 600ms;"></div>
        </div>
        <span style="font-family:var(--mono);font-size:13px;font-weight:600;color:${color};text-align:right;">${fmt.usd(cost)}</span>
      </div>`;
  };

  return `
    <div style="display:grid;grid-template-columns:auto 1fr;gap:0;margin-bottom:14px;
      background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden;">
      <div style="padding:16px 24px;border-right:1px solid var(--border);display:flex;flex-direction:column;justify-content:center;min-width:160px;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:var(--muted);margin-bottom:4px;">
          7-day API-equiv. cost
        </div>
        <div style="font-family:var(--mono);font-size:34px;font-weight:600;letter-spacing:-.04em;color:var(--good);line-height:1;">
          ${fmt.usd(total)}
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">all providers combined</div>
      </div>
      <div style="padding:14px 20px;display:flex;flex-direction:column;gap:10px;justify-content:center;">
        ${providerRow('Claude Code', 'var(--provider-claude)', claudeCost, 'provider-claude', 'CC')}
        ${providerRow('Codex',       'var(--provider-codex)',  codexCost,  'provider-codex',  'AI')}
        <div style="display:flex;gap:16px;padding-top:6px;border-top:1px solid var(--border);font-size:11px;color:var(--muted);">
          <span>${fmt.int((claudeT.sessions||0)+(codexT.sessions||0))} sessions</span>
          <span>${fmt.int((claudeT.turns||0)+(codexT.turns||0))} turns</span>
          <a href="#/overview" style="margin-left:auto;font-size:12px;">Full overview →</a>
        </div>
      </div>
    </div>`;
}

// ── inline limits strip ───────────────────────────────────────────────────────
function limitsStrip(limits, sessSum, hourSum, weekSum) {
  const showUsed = localStorage.getItem('td.limits-show-used') !== '0';
  const now = new Date();

  function cell(label, used, lim, summary, resetLabel, color) {
    const pct       = lim ? Math.round((used / lim) * 100) : null;
    const statColor = summary.status.cls === 'exceeded' ? 'var(--bad)'
      : summary.status.cls === 'near'     ? 'var(--warn)'
      : summary.status.cls === 'caution'  ? 'var(--accent)'
      : color;
    const pctLabel  = pct == null ? 'not set'
      : showUsed ? `${pct}% used` : `${100-pct}% left`;
    const fillW     = pct != null ? Math.min(100, pct) : 0;

    return `
      <div style="flex:1;padding:10px 14px;background:var(--panel);display:flex;flex-direction:column;gap:5px;min-width:0;">
        <div style="font-size:11px;font-weight:600;color:var(--text);">${label}</div>
        <div style="position:relative;height:6px;background:var(--bg);border-radius:999px;border:1px solid var(--border);overflow:hidden;">
          <div style="position:absolute;inset:0;border-radius:999px;overflow:hidden;">
            <div style="height:100%;width:${fillW}%;background:${statColor};border-radius:999px;transition:width 700ms;"></div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;">
          <span style="color:${statColor};font-weight:600;">${pctLabel}</span>
          <span style="color:var(--muted-2);">${fmt.htmlSafe(resetLabel)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;color:var(--muted);">
          <span>${fmt.compact(used)} used</span>
          ${lim ? `<span>${fmt.compact(Math.max(0,lim-used))} left</span>` : '<span>no cap set</span>'}
        </div>
      </div>`;
  }

  const nextHour = new Date(now); nextHour.setMinutes(0,0,0); nextHour.setHours(nextHour.getHours()+1);
  const daysToMon = (8-now.getDay())%7||7;
  const nextMon = new Date(now); nextMon.setDate(nextMon.getDate()+daysToMon); nextMon.setHours(0,0,0,0);
  const hmsMs = nextHour - now;
  const mm = String(Math.floor((hmsMs%3600000)/60000)).padStart(2,'0');
  const ss = String(Math.floor((hmsMs%60000)/1000)).padStart(2,'0');
  const wd = Math.floor((nextMon-now)/86400000);
  const wh = Math.floor(((nextMon-now)%86400000)/3600000);

  return `
    <div style="margin-bottom:14px;border:1px solid var(--border);border-radius:10px;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;
        background:var(--panel-2);border-bottom:1px solid var(--border);">
        <span style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;">Usage limits</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <div class="range-tabs" id="home-pct-toggle" style="padding:1px;font-size:11px;">
            <button data-v="1" class="${showUsed?'active':''}" style="padding:3px 8px;">% used</button>
            <button data-v="0" class="${!showUsed?'active':''}" style="padding:3px 8px;">% left</button>
          </div>
          <a href="#/limits" style="font-size:11px;color:var(--accent);">Full limits →</a>
          <a href="#/settings" style="font-size:11px;color:var(--muted);">Configure</a>
        </div>
      </div>
      <div style="display:flex;gap:1px;background:var(--border);">
        ${cell('Session',      sessSum.used, limits.sessionTokens, sessSum, 'session ends',      'var(--good)')}
        ${cell('Rolling hour', hourSum.used, limits.hourlyTokens,  hourSum, `↺ ${mm}:${ss}`,    'var(--warn)')}
        ${cell('Weekly',       weekSum.used, limits.weeklyTokens,  weekSum, `↺ ${wd}d ${wh}h`,  'var(--accent)')}
      </div>
    </div>`;
}

// ── KPI strip ─────────────────────────────────────────────────────────────────
function kpiStrip(totals, planHtml) {
  const cc = cacheCreate(totals);
  const k = (label, compactVal, fullVal, cls = '') => `
    <div class="card kpi ${cls}">
      <div class="label">${label}</div>
      <div class="value" title="${fullVal}">${compactVal}</div>
    </div>`;
  return `
    <div class="row cols-7 home-kpis">
      ${k('Sessions',     fmt.int(totals.sessions),           fmt.int(totals.sessions))}
      ${k('Turns',        fmt.int(totals.turns),              fmt.int(totals.turns))}
      ${k('Input',        fmt.compact(totals.input_tokens),   fmt.int(totals.input_tokens)+' tokens')}
      ${k('Output',       fmt.compact(totals.output_tokens),  fmt.int(totals.output_tokens)+' tokens')}
      ${k('Cache read',   fmt.compact(totals.cache_read_tokens), fmt.int(totals.cache_read_tokens)+' tokens')}
      ${k('Cache create', fmt.compact(cc),                    fmt.int(cc)+' tokens')}
      <div class="card kpi cost">
        <div class="label">Est. cost</div>
        <div class="value" title="${fmt.usd(totals.cost_usd)}">${fmt.usd(totals.cost_usd)}</div>
        ${planHtml}
      </div>
    </div>`;
}

// ── provider column card ──────────────────────────────────────────────────────
function columnCard(sourceObj, totals, emptyMsg) {
  const src       = sourceObj.provider || 'claude';
  const detail    = `#/overview?provider=${encodeURIComponent(src)}`;
  const sessions  = `#/sessions?provider=${encodeURIComponent(src)}`;
  const label     = sourceObj.label || src;
  const rows      = sourceObj.cached_messages ?? 0;
  const connected = sourceObj.status === 'connected';
  let banner = '';
  if (src === 'codex' && sourceObj.status === 'disabled') {
    banner = `<p class="home-col-banner muted">${fmt.htmlSafe(sourceObj.hint || 'Enable Codex in CLI or set a Codex home, then rescan.')}</p>`;
  } else if (sourceObj.status === 'missing') {
    banner = `<p class="home-col-banner warn">${fmt.htmlSafe(sourceObj.hint || 'Path not found.')}</p>`;
  } else if (rows === 0 && connected) {
    banner = `<p class="home-col-banner muted">${emptyMsg}</p>`;
  }
  return `
    <section class="card home-col" data-provider="${fmt.htmlSafe(src)}">
      <div class="home-col-head">
        <h2 style="margin:0;font-size:15px">${fmt.htmlSafe(label)}</h2>
        <div class="spacer"></div>
        <a href="${detail}" class="small-link">Full overview →</a>
        <a href="${sessions}" class="small-link">Sessions →</a>
      </div>
      <p class="muted" style="margin:6px 0 12px;font-size:12px">Last 7 days · same metrics as Overview</p>
      ${banner}
      ${kpiStrip(totals, planSubtitle())}
    </section>`;
}

// ── main ──────────────────────────────────────────────────────────────────────
export default async function(root) {
  const tab    = readHashParam('tab', 'split') || 'split';
  const since7 = sinceIsoDays(7);
  const now    = new Date();

  const [meta, claudeT, codexT, usageSettings, currentSession] = await Promise.all([
    optionalApi('/api/sources', { sources:[] }),
    api(withQuery('/api/overview', { since:since7, provider:'claude' })),
    api(withQuery('/api/overview', { since:since7, provider:'codex'  })),
    loadUsageSettings(api),
    api('/api/current-session').catch(() => ({})),
  ]);

  const limits     = limitForProvider(usageSettings, 'all');
  const hourWindow = rollingHourWindow(now);
  const weekWindow = currentWeekWindow(now, limits.weekStartDay);

  const [hourData, weekData] = await Promise.all([
    api(withQuery('/api/overview', { since:hourWindow.start.toISOString(), until:hourWindow.end.toISOString() })),
    api(withQuery('/api/overview', { since:weekWindow.start.toISOString(), until:weekWindow.reset.toISOString() })),
  ]);

  const sessSum = sessionLimitSummary(currentSession.session || null, limits);
  const hourSum = hourlyLimitSummary(hourData, limits);
  const weekSum = weeklyLimitSummary(weekData, limits);

  const claudeMeta = meta.sources.find(s => s.provider === 'claude') || { provider:'claude', label:'Claude Code' };
  const codexMeta  = meta.sources.find(s => s.provider === 'codex')  || { provider:'codex',  label:'Codex'       };
  const sourcesStrip = dataSourcePanel(meta, { compact:true });

  const tabs = `
    <div class="home-tabs" role="tablist">
      <button type="button" data-tab="split"  class="${tab==='split' ?'active':''}">Split</button>
      <button type="button" data-tab="claude" class="${tab==='claude'?'active':''}">Claude</button>
      <button type="button" data-tab="codex"  class="${tab==='codex' ?'active':''}">Codex</button>
    </div>`;

  let main;
  if (tab === 'claude') {
    main = `<div class="home-single">${columnCard(claudeMeta, claudeT, 'No Claude data yet.')}</div>`;
  } else if (tab === 'codex') {
    main = `<div class="home-single">${columnCard(codexMeta,  codexT,  'No Codex data yet.')}</div>`;
  } else {
    main = `<div class="row cols-2 home-split">
      ${columnCard(claudeMeta, claudeT, 'No Claude sessions in range yet.')}
      ${columnCard(codexMeta,  codexT,  'No Codex rows ingested yet.')}
    </div>`;
  }

  root.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
      <h2 style="margin:0;font-size:16px;letter-spacing:-.01em;">Agent summary</h2>
      <span class="muted" style="font-size:12px;">Claude Code vs Codex · 7-day totals</span>
    </div>

    ${costHero(claudeT, codexT)}
    ${limitsStrip(limits, sessSum, hourSum, weekSum)}
    ${tabs}
    ${sourcesStrip}
    ${main}`;

  // % used / % left toggle
  root.querySelector('#home-pct-toggle')?.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    localStorage.setItem('td.limits-show-used', btn.dataset.v);
    window.dispatchEvent(new Event('hashchange'));
  });

  // Tab switcher
  root.querySelectorAll('.home-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tab;
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      if (t === 'split') params.delete('tab'); else params.set('tab', t);
      const q = params.toString();
      location.hash = '#/home' + (q ? '?'+q : '');
    });
  });
}
