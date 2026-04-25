// web/routes/limits.js — full redesign matching mockup
// Arc meters · 3-card grid · pace bar with tick · history bars · % used/left toggle
import { api, fmt, providerTabs, readProvider, withQuery, writeHashParams } from '/web/app.js';
import {
  currentWeekWindow,
  hourlyLimitSummary,
  limitForProvider,
  loadUsageSettings,
  progressPct,
  rollingHourWindow,
  sessionLimitSummary,
  warningLabel,
  weeklyLimitSummary,
} from '/web/limits.js';
import { paceHistory, recordPacePoint } from '/web/pace-history.js';

// ── helpers ───────────────────────────────────────────────────────────────────
function statusColor(cls) {
  return { exceeded:'var(--bad)', near:'var(--warn)', caution:'var(--accent)', normal:'var(--good)' }[cls] || 'var(--good)';
}
function statusName(cls) {
  return { exceeded:'Exceeded', near:'Near limit', caution:'Caution', normal:'Normal' }[cls] || 'Normal';
}
function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m`;
  return `${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}
function fmtWeekCountdown(ms) {
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return d > 0 ? `${d}d ${h}h ${String(m).padStart(2,'0')}m` : `${h}h ${String(m).padStart(2,'0')}m`;
}

// ── SVG arc meter ─────────────────────────────────────────────────────────────
function arcSvg(pct, color) {
  const r = 38, circ = 2 * Math.PI * r, dash = circ * 0.75;
  const off = dash * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return `
    <svg width="100" height="72" viewBox="0 0 100 72" aria-hidden="true">
      <path d="M 14.6 85.4 A 38 38 0 1 1 85.4 85.4"
        fill="none" stroke="var(--border-2)" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(2)} ${circ.toFixed(2)}"/>
      <path d="M 14.6 85.4 A 38 38 0 1 1 85.4 85.4"
        fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(2)} ${circ.toFixed(2)}"
        stroke-dashoffset="${off.toFixed(2)}"
        style="transition:stroke-dashoffset 700ms cubic-bezier(.4,0,.2,1)"/>
      <text x="50" y="54" text-anchor="middle" font-size="14" font-weight="600"
        fill="var(--text)" font-family="JetBrains Mono,monospace">${Math.round(pct)}%</text>
      <text x="50" y="66" text-anchor="middle" font-size="9"
        fill="var(--muted)" font-family="JetBrains Mono,monospace">${Math.round(pct)}% used</text>
    </svg>`;
}

// ── pace bar with tick marker ─────────────────────────────────────────────────
function paceBarHtml(pct, pacePct, color) {
  const p = Math.min(100, Math.max(0, pct));
  return `
    <div class="pace-bar-wrap">
      <div class="pace-bar-fill-outer">
        <div class="pace-bar-fill-inner" style="width:${p}%;background:${color};"></div>
      </div>
      ${pacePct != null ? `<div class="pace-bar-tick" style="left:${Math.min(100,Math.max(0,pacePct))}%;" title="Historical pace: ${Math.round(pacePct)}%"></div>` : ''}
    </div>`;
}

// ── utilization history bars ──────────────────────────────────────────────────
function historyBarsHtml(points, color) {
  if (!points || !points.length) {
    return '<div style="font-size:11px;color:var(--muted);margin-top:6px;">No history yet — check back after more sessions.</div>';
  }
  const max = Math.max(100, ...points.map(p => p.pct || 0));
  return `
    <div class="util-history-wrap">
      ${points.map((p, i) => {
        const pct = Math.max(0, Math.min(100, p.pct || 0));
        const h   = Math.max(3, Math.round((pct / max) * 100));
        const isCur = i === points.length - 1;
        const c   = pct >= 90 ? 'var(--bad)' : pct >= 75 ? 'var(--warn)' : color;
        return `
          <div class="util-history-bar${isCur ? ' current' : ''}" title="${pct}% used">
            <div class="util-history-track">
              <div class="util-history-fill" style="height:${h}%;background:${isCur ? c : `color-mix(in srgb,${c} 55%,var(--border))`};"></div>
            </div>
            <div class="util-history-label">${pct}%</div>
          </div>`;
      }).join('')}
    </div>`;
}

// ── single limit card ─────────────────────────────────────────────────────────
function limitCard({ label, used, limit, statusCls, color, resetText, burnRate, pacePct, history, showUsed }) {
  if (!limit) return `
    <div class="card" style="padding:16px;text-align:center;color:var(--muted);">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.09em;font-weight:700;margin-bottom:8px;">${label} limit</div>
      <div style="font-size:12px;">Not configured.</div>
      <a href="#/settings" style="font-size:12px;">Set in Settings →</a>
    </div>`;

  const pct       = Math.round((used / limit) * 100);
  const remaining = Math.max(0, limit - used);
  const statColor = statusColor(statusCls);
  const pctLabel  = showUsed ? `${pct}% used` : `${100 - pct}% left`;
  const isAhead   = pacePct != null ? pct <= pacePct : null;

  return `
    <div class="card" style="overflow:hidden;border-color:${pct>=90?'rgba(229,72,77,0.4)':pct>=75?'rgba(232,162,59,0.35)':'var(--border)'};">
      <div style="height:3px;background:${statColor};opacity:.8;margin:-18px -18px 14px;"></div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <span style="font-size:11px;text-transform:uppercase;letter-spacing:.09em;font-weight:700;color:var(--muted);">${label} limit</span>
        <span style="padding:2px 8px;border-radius:4px;font-size:10px;font-family:var(--mono);font-weight:600;
          color:${statColor};border:1px solid color-mix(in srgb,${statColor} 35%,transparent);
          background:color-mix(in srgb,${statColor} 10%,transparent);">${statusName(statusCls)}</span>
      </div>

      <div style="display:flex;justify-content:center;margin:0 0 12px;">${arcSvg(pct, statColor)}</div>

      ${paceBarHtml(pct, pacePct, statColor)}

      <div style="display:flex;justify-content:space-between;margin-top:6px;margin-bottom:3px;">
        <span style="font-family:var(--mono);font-size:13px;font-weight:600;color:${statColor};">${pctLabel}</span>
        <span style="font-family:var(--mono);font-size:10px;color:var(--muted-2);" data-countdown="${label.toLowerCase()}">${resetText}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;font-family:var(--mono);color:var(--muted);margin-bottom:12px;">
        <span>${fmt.compact(remaining)} remaining</span>
        ${isAhead !== null ? `<span style="color:${isAhead?'var(--good)':'var(--warn)'};">${isAhead?'↑ ahead':'↓ behind'} pace</span>` : ''}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
        <div style="padding:9px 11px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--muted);">Used</div>
          <div style="font-family:var(--mono);font-size:14px;margin-top:3px;">${fmt.compact(used)}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;font-family:var(--mono);">of ${fmt.compact(limit)}</div>
        </div>
        <div style="padding:9px 11px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--muted);">Burn rate</div>
          <div style="font-family:var(--mono);font-size:14px;margin-top:3px;">${burnRate}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;font-family:var(--mono);">current pace</div>
        </div>
      </div>

      <div style="padding-top:10px;border-top:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.07em;font-weight:600;">
          <span>Usage history</span>
          ${isAhead !== null ? `<span style="color:${isAhead?'var(--good)':'var(--warn)'};">${isAhead?'↑ ahead':'↓ behind'} of pace</span>` : ''}
        </div>
        ${historyBarsHtml(history, statColor)}
      </div>
    </div>`;
}

// ── main route ────────────────────────────────────────────────────────────────
export default async function(root) {
  const provider      = readProvider();
  const showUsed      = localStorage.getItem('td.limits-show-used') !== '0';
  const usageSettings = await loadUsageSettings(api);
  const limits        = limitForProvider(usageSettings, provider.key);
  const now           = new Date();
  const hourWindow    = rollingHourWindow(now);
  const weekWindow    = currentWeekWindow(now, limits.weekStartDay);
  const queryProvider = provider.key === 'all' ? null : provider.key;

  const [currentSession, currentHour, currentWeek] = await Promise.all([
    api(withQuery('/api/current-session', { provider: queryProvider })),
    api(withQuery('/api/overview', { since: hourWindow.start.toISOString(), until: hourWindow.end.toISOString(), provider: queryProvider })),
    api(withQuery('/api/overview', { since: weekWindow.start.toISOString(), until: weekWindow.reset.toISOString(), provider: queryProvider })),
  ]);

  const sessSummary = sessionLimitSummary(currentSession.session || null, limits);
  const hourSummary = hourlyLimitSummary(currentHour, limits);
  const weekSummary = weeklyLimitSummary(currentWeek, limits);

  // Record weekly pace point
  const weekStartIso = weekWindow.start.toISOString().slice(0, 10);
  if (limits.weeklyTokens && weekSummary.status.pct != null) {
    recordPacePoint({ providerKey: provider.key, weekStartIso, pct: weekSummary.pct, ts: Math.floor(Date.now() / 3600000) * 3600000 });
  }
  const weekHistory = paceHistory(provider.key, weekStartIso);

  // Linear expected pace for the week (simple fallback until history accumulates)
  const weekElapsedMs  = now - weekWindow.start;
  const weekTotalMs    = weekWindow.reset - weekWindow.start;
  const weekLinearPct  = Math.round((weekElapsedMs / weekTotalMs) * 100);
  const hourElapsedMs  = now - hourWindow.start;
  const hourLinearPct  = Math.round((hourElapsedMs / 3600000) * 100);

  // Burn rates
  const sessBurn  = sessSummary.used > 0 ? fmt.compact(Math.round(sessSummary.used / Math.max(1, (now - new Date(currentSession.session?.started_at || now)) / 60000))) + '/min' : '—';
  const hourBurn  = hourSummary.used  > 0 ? fmt.compact(Math.round(hourSummary.used / Math.max(1, hourElapsedMs / 60000))) + '/min' : '—';
  const weekBurn  = weekSummary.used  > 0 ? fmt.compact(Math.round(weekSummary.used / Math.max(1, weekElapsedMs / 86400000))) + '/day' : '—';

  // Countdowns
  const hourResetMs = hourWindow.end - now;
  const weekResetMs = weekWindow.reset - now;

  root.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
      <h2 style="margin:0;font-size:16px;letter-spacing:-.02em;">Usage Limits</h2>
      <span style="color:var(--muted);font-size:12px;">
        <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--good);margin-right:5px;animation:pulse 2s ease-in-out infinite;"></span>
        live · ${provider.key === 'all' ? 'all providers' : fmt.htmlSafe(fmt.providerLabel(provider.key))}
      </span>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
        <div class="range-tabs" id="pct-toggle">
          <button data-v="1" class="${showUsed?'active':''}">% used</button>
          <button data-v="0" class="${!showUsed?'active':''}">% left</button>
        </div>
        ${providerTabs(provider.key)}
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;font-size:11px;color:var(--muted);
      padding:8px 12px;background:var(--panel);border:1px solid var(--border);border-radius:8px;">
      <span style="display:flex;align-items:center;gap:6px;">
        <span style="display:inline-block;width:20px;height:5px;background:var(--accent);border-radius:3px;"></span>Current usage
      </span>
      <span style="display:flex;align-items:center;gap:6px;">
        <span style="display:inline-block;width:2px;height:12px;background:rgba(255,255,255,.36);border-radius:1px;"></span>Expected linear pace
      </span>
      <a href="#/settings" style="margin-left:auto;font-size:11px;">Configure limits →</a>
    </div>

    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px;" id="limits-cards">
      ${limitCard({ label:'Session', used:sessSummary.used, limit:limits.sessionTokens,
        statusCls:sessSummary.status.cls||'normal', color:'var(--good)',
        resetText:'session ends', burnRate:sessBurn, pacePct:null,
        history:[], showUsed })}
      ${limitCard({ label:'Hourly', used:hourSummary.used, limit:limits.hourlyTokens,
        statusCls:hourSummary.status.cls||'normal', color:'var(--warn)',
        resetText:fmtCountdown(hourResetMs), burnRate:hourBurn, pacePct:hourLinearPct,
        history:[], showUsed })}
      ${limitCard({ label:'Weekly', used:weekSummary.used, limit:limits.weeklyTokens,
        statusCls:weekSummary.status.cls||'normal', color:'var(--accent)',
        resetText:fmtWeekCountdown(weekResetMs), burnRate:weekBurn, pacePct:weekLinearPct,
        history:weekHistory, showUsed })}
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
        <h3 style="margin:0;font-size:13px;">Pace notes</h3>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
        ${[
          ['Session', sessSummary, limits.sessionTokens, 'Session'],
          ['Hourly',  hourSummary, limits.hourlyTokens,  'Hourly'],
          ['Weekly',  weekSummary, limits.weeklyTokens,  'Weekly'],
        ].map(([label, summary, lim, noun]) => {
          const w = warningLabel(summary.status, lim ? Math.max(0, lim - summary.used) : null, noun);
          return `<div style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--muted);margin-bottom:4px;">${label}</div>
            <div style="font-size:12px;color:${w?statusColor(summary.status.cls):'var(--muted)'};">${w || 'Within normal limits.'}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  // % used / % left toggle
  root.querySelector('#pct-toggle')?.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    localStorage.setItem('td.limits-show-used', btn.dataset.v);
    window.dispatchEvent(new Event('hashchange'));
  });

  // Provider tabs
  root.querySelectorAll('.provider-tabs button').forEach(btn => {
    btn.addEventListener('click', () => writeHashParams({ provider: btn.dataset.provider === 'all' ? null : btn.dataset.provider }));
  });

  // Live countdown every second
  const interval = setInterval(() => {
    const n = new Date();
    const nh = new Date(n); nh.setMinutes(0,0,0); nh.setHours(nh.getHours()+1);
    const dtm = (8-n.getDay())%7||7;
    const nm = new Date(n); nm.setDate(nm.getDate()+dtm); nm.setHours(0,0,0,0);
    root.querySelectorAll('[data-countdown="hourly"]').forEach(el => { el.textContent = fmtCountdown(nh - n); });
    root.querySelectorAll('[data-countdown="weekly"]').forEach(el => { el.textContent = fmtWeekCountdown(nm - n); });
  }, 1000);
  window.addEventListener('hashchange', () => clearInterval(interval), { once: true });
}
