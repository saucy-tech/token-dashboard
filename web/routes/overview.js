import {
  api,
  dataSourcePanel,
  fmt,
  optionalApi,
  providerTabs,
  readHashParam,
  readProvider,
  state,
  withQuery,
  writeHashParams,
} from '/web/app.js';
import { barChart, donutChart, groupedBarChart, lineChart, stackedBarChart } from '/web/charts.js';
import { billableTokens, currentWeekWindow, limitStatus, progressPct } from '/web/limits.js';

const RANGES = [
  { key: '7d',  label: '7d',  days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: 'All', days: null },
];

function readRange() {
  const k = readHashParam('range');
  return RANGES.find(r => r.key === k) || RANGES[1];
}

function writeRange(key) {
  writeHashParams({ range: key });
}

function sinceIso(range) {
  if (!range.days) return null;
  return new Date(Date.now() - range.days * 86400 * 1000).toISOString();
}

function writeProvider(key) {
  writeHashParams({ provider: key === 'all' ? null : key });
}

function queryParams(since, provider) {
  return {
    since,
    provider: provider.key === 'all' ? null : provider.key,
  };
}

function sessionsHref(provider) {
  return provider.key === 'all'
    ? '#/sessions'
    : '#/sessions?provider=' + encodeURIComponent(provider.key);
}

function sessionHref(sessionId, provider) {
  return '#/sessions/' + encodeURIComponent(sessionId) + (
    provider.key === 'all' ? '' : '?provider=' + encodeURIComponent(provider.key)
  );
}

export default async function (root) {
  const range = readRange();
  const provider = readProvider();
  const since = sinceIso(range);
  const params = queryParams(since, provider);
  const weeklyBudget = readWeeklyBudget();
  const weekWindow = currentWeekWindow(new Date(), readWeekStartDay());
  const weekParams = {
    since: weekWindow.start.toISOString(),
    until: weekWindow.reset.toISOString(),
    provider: provider.key === 'all' ? null : provider.key,
  };

  const [totals, currentWeek, trends, projects, sessions, currentSession, tools, daily, byModel, providers, sources] = await Promise.all([
    api(withQuery('/api/overview', params)),
    api(withQuery('/api/overview', weekParams)),
    api(withQuery('/api/trends', {
      provider: provider.key === 'all' ? null : provider.key,
      weeks: 12,
      budget_usd: weeklyBudget,
    })),
    api(withQuery('/api/projects', params)),
    api(withQuery('/api/sessions', { ...params, limit: 10 })),
    api(withQuery('/api/current-session', {
      provider: provider.key === 'all' ? null : provider.key,
    })),
    api(withQuery('/api/tools', params)),
    api(withQuery('/api/daily', params)),
    api(withQuery('/api/by-model', params)),
    api(withQuery('/api/providers', params)),
    optionalApi('/api/sources', { sources: [] }),
  ]);

  const cacheCreate =
    (totals.cache_create_5m_tokens || 0) +
    (totals.cache_create_1h_tokens || 0);

  const kpi = (label, compactVal, fullVal, cls = '') => `
    <div class="card kpi ${cls}">
      <div class="label">${label}</div>
      <div class="value" title="${fullVal}">${compactVal}</div>
    </div>`;

  const providerCards = providers.map(p => {
    const billable =
      (p.input_tokens || 0) +
      (p.output_tokens || 0) +
      (p.cache_create_5m_tokens || 0) +
      (p.cache_create_1h_tokens || 0);
    return `
      <div class="card">
        <h3 style="display:flex;align-items:center">
          <span>${fmt.htmlSafe(fmt.providerLabel(p.provider))}</span>
          <span class="spacer"></span>
          <span class="badge ${fmt.providerClass(p.provider)}">${fmt.htmlSafe(p.provider)}</span>
        </h3>
        <div class="flex muted" style="font-family:var(--mono);font-size:12px;justify-content:space-between">
          <span>${fmt.int(p.sessions)} sessions</span>
          <span>${fmt.int(p.turns)} turns</span>
        </div>
        <div style="margin-top:10px;font-family:var(--mono);font-size:22px;letter-spacing:-0.03em">${fmt.compact(billable)}</div>
        <div class="muted" style="margin-top:4px;font-size:12px">billable tokens</div>
      </div>`;
  }).join('');

  const costSub = costSubtitle(totals);
  const trendWeeks = trends.weeks || [];
  const latestWeek = trendWeeks[trendWeeks.length - 1] || {};
  const budget = trends.budget;
  const usageLimits = readUsageLimits();

  const rangeTabs = `
    <div class="range-tabs" role="tablist">
      ${RANGES.map(r => `<button data-range="${r.key}" class="${r.key === range.key ? 'active' : ''}">${r.label}</button>`).join('')}
    </div>`;
  const selectedProvider = provider.key === 'all' ? 'all providers' : fmt.providerLabel(provider.key);

  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Overview</h2>
      <span class="muted" style="font-size:12px">${range.days ? `last ${range.days} days` : 'all time'} · ${fmt.htmlSafe(selectedProvider)}</span>
      <div class="spacer"></div>
      ${rangeTabs}
    </div>

    <div class="flex" style="margin:-4px 0 16px;justify-content:flex-end">
      ${providerTabs(provider.key)}
    </div>

    <div style="margin-bottom:16px">
      ${dataSourcePanel(sources, { scanButton: true })}
    </div>

    <div class="row cols-7">
      ${kpi('Sessions',     fmt.int(totals.sessions),       fmt.int(totals.sessions))}
      ${kpi('Turns',        fmt.int(totals.turns),          fmt.int(totals.turns))}
      ${kpi('Input',        fmt.compact(totals.input_tokens),       fmt.int(totals.input_tokens) + ' tokens')}
      ${kpi('Output',       fmt.compact(totals.output_tokens),      fmt.int(totals.output_tokens) + ' tokens')}
      ${kpi('Cache read',   fmt.compact(totals.cache_read_tokens),  fmt.int(totals.cache_read_tokens) + ' tokens')}
      ${kpi('Cache create', fmt.compact(cacheCreate),               fmt.int(cacheCreate) + ' tokens')}
      <div class="card kpi cost">
        <div class="label">API-equiv. cost</div>
        <div class="value" title="${fmt.usd(totals.cost_usd)}">${fmt.usd(totals.cost_usd)}</div>
        ${costSub}
      </div>
    </div>

    ${usageLimitsSection({
      latestSession: currentSession.session,
      currentWeek,
      weekWindow,
      trendWeeks,
      budget,
      limits: usageLimits,
      provider,
      sources,
    })}

    <div class="overview-section-head">
      <h3>Trends</h3>
      <div class="trend-budget">
        <label for="weekly-budget">Weekly budget</label>
        <input id="weekly-budget" type="number" min="0" step="1" inputmode="decimal" value="${weeklyBudget ?? ''}" placeholder="—">
        <button class="ghost" id="save-weekly-budget">Save</button>
      </div>
    </div>

    <div class="row cols-4">
      ${trendKpi('Current week', latestWeek.start_date || '—', latestWeek.end_date ? `through ${latestWeek.end_date}` : 'weekly rollup')}
      ${trendKpi('Billable tokens', fmt.compact(latestWeek.billable_tokens), deltaText(trends.deltas?.billable_tokens), deltaClass(trends.deltas?.billable_tokens))}
      ${trendKpi('API-equiv. cost', fmt.usd(latestWeek.cost_usd), deltaText(trends.deltas?.cost_usd, fmt.usd), deltaClass(trends.deltas?.cost_usd))}
      ${budgetKpi(budget)}
    </div>

    <div class="row cols-2" style="margin-top:16px">
      <div class="card">
        <h3>Weekly rollups</h3>
        <div id="ch-weekly-rollups" style="height:280px"></div>
      </div>
      <div class="card">
        <h3>Top cost drivers</h3>
        <table>
          <thead><tr><th>driver</th><th class="num">tokens</th><th class="num">cost</th></tr></thead>
          <tbody>
            ${driverRows(trends.top_cost_drivers || [])}
          </tbody>
        </table>
      </div>
    </div>

    <div class="row cols-2" style="margin-top:16px">
      <div class="card">
        <h3>Projects over time</h3>
        <div id="ch-project-trends" style="height:300px"></div>
      </div>
      <div class="card">
        <h3>Models over time</h3>
        <div id="ch-model-trends" style="height:300px"></div>
      </div>
    </div>

    <details class="card glossary" style="margin-top:16px">
      <summary><h3 style="display:inline-block;margin:0">What do these numbers mean?</h3><span class="muted" style="font-size:12px">— click to expand</span></summary>
      <dl>
        <dt>Session</dt><dd>One run of a supported coding assistant, stored locally as a transcript or session log.</dd>
        <dt>Turn</dt><dd>One message you sent to the assistant. Each turn triggers at least one model response and may include tool calls.</dd>
        <dt>Input tokens</dt><dd>The new text you and your tool results sent to the model. Billed at the full input rate when pricing is available.</dd>
        <dt>Output tokens</dt><dd>The text the assistant wrote back. This is usually the biggest cost driver per turn.</dd>
        <dt>Cache read</dt><dd>Tokens re-used from cached context. High cache-read counts usually mean better context re-use and lower marginal cost.</dd>
        <dt>Cache create</dt><dd>Writing something into the cache for the first time. One-time cost; pays off on the next turn.</dd>
        <dt>Billable tokens</dt><dd>Input + Output + Cache create. Cache reads are billed separately (and much cheaper).</dd>
        <dt>API-equivalent cost</dt><dd>Estimated from token rates in <code>pricing.json</code>. Subscription plans are shown as context, not added to this number.</dd>
        <dt>Current session</dt><dd>The most recent locally scanned assistant session for the selected provider. It may trail the vendor app until the next scan finishes.</dd>
        <dt>Weekly limit</dt><dd>A dashboard-tracked threshold you set for this local data. It is not a guaranteed vendor quota.</dd>
        <dt>Remaining usage</dt><dd>Your configured weekly limit minus the current local weekly total. Missing or unscanned sources can make this optimistic.</dd>
        <dt>Reset time</dt><dd>The next local calendar-week boundary used by the dashboard: Monday at 00:00 in your browser's time zone.</dd>
      </dl>
    </details>

    ${providers.length ? `
      <div class="row cols-3" style="margin-top:16px">
        ${providerCards}
      </div>` : ''}

    <div class="row cols-2" style="margin-top:16px">
      <div class="card">
        <h3>Your daily work</h3>
        <p class="muted" style="margin:-4px 0 10px;font-size:12px">Tokens you paid for: what you sent (<b>input</b>), what the assistant wrote (<b>output</b>), and what got stored for re-use (<b>cache create</b>).</p>
        <div id="ch-daily-billable" style="height:260px"></div>
      </div>
      <div class="card">
        <h3>Daily cache reads</h3>
        <p class="muted" style="margin:-4px 0 10px;font-size:12px"><b>Cache reads</b> are cheap re-uses of things the model already saw. They usually cost far less than fresh input tokens.</p>
        <div id="ch-daily-cache" style="height:260px"></div>
      </div>
    </div>

    <div class="row cols-2" style="margin-top:16px">
      <div class="card"><h3>Tokens by project</h3><div id="ch-projects" style="height:320px"></div></div>
      <div class="card">
        <h3>Token usage by model</h3>
        <p class="muted" style="margin:-4px 0 4px;font-size:12px">Share of billable tokens per model in the current filtered view.</p>
        <div id="ch-model" style="height:300px"></div>
      </div>
    </div>

    <div class="row cols-2" style="margin-top:16px">
      <div class="card"><h3>Top tools (by call count)</h3><div id="ch-tools" style="height:320px"></div></div>
      <div class="card">
        <h3 style="display:flex;align-items:center"><span>Recent sessions</span><span class="spacer"></span><a href="${sessionsHref(provider)}" style="font-weight:400;font-size:12px">all →</a></h3>
        <table>
          <thead><tr><th>started</th><th>project</th><th class="num">tokens</th></tr></thead>
          <tbody>
            ${sessions.map(s => `
              <tr>
                <td class="mono">${fmt.ts(s.started)}</td>
                <td><a href="${sessionHref(s.session_id, provider)}">${fmt.htmlSafe(s.project_name || s.project_slug)}</a></td>
                <td class="num">${fmt.compact(s.tokens)}</td>
              </tr>`).join('') || '<tr><td colspan="3" class="muted">no sessions in this range</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // range buttons
  root.querySelectorAll('.range-tabs button').forEach(btn => {
    if (btn.dataset.range) btn.addEventListener('click', () => writeRange(btn.dataset.range));
    if (btn.dataset.provider) btn.addEventListener('click', () => writeProvider(btn.dataset.provider));
  });
  root.querySelector('[data-scan-now]')?.addEventListener('click', async event => {
    event.currentTarget.textContent = 'Scanning...';
    await api('/api/scan');
    window.dispatchEvent(new Event('hashchange'));
  });
  root.querySelector('#save-weekly-budget')?.addEventListener('click', () => {
    const raw = root.querySelector('#weekly-budget')?.value || '';
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value <= 0) {
      localStorage.removeItem('td.weekly-budget-usd');
    } else {
      localStorage.setItem('td.weekly-budget-usd', String(value));
    }
    window.dispatchEvent(new Event('hashchange'));
  });

  lineChart(document.getElementById('ch-weekly-rollups'), {
    x: trendWeeks.map(w => w.start_date),
    series: [
      { name: 'billable', data: trendWeeks.map(w => w.billable_tokens || 0), color: '#4A9EFF' },
      { name: 'cache read', data: trendWeeks.map(w => w.cache_read_tokens || 0), color: '#3FB68B' },
    ],
  });

  lineChart(document.getElementById('ch-project-trends'), {
    x: trends.project_series?.weeks || [],
    series: (trends.project_series?.series || []).map((s, i) => ({
      name: fmt.short(s.label, 22),
      data: s.values,
      color: ['#4A9EFF', '#7C5CFF', '#3FB68B', '#E8A23B', '#E5484D', '#5BCEDA'][i % 6],
    })),
  });

  lineChart(document.getElementById('ch-model-trends'), {
    x: trends.model_series?.weeks || [],
    series: (trends.model_series?.series || []).map((s, i) => ({
      name: fmt.modelShort(s.label),
      data: s.values,
      color: ['#7C5CFF', '#4A9EFF', '#3FB68B', '#E8A23B', '#E5484D', '#5BCEDA'][i % 6],
    })),
  });

  // Your daily work — billable tokens (input + output + cache create)
  stackedBarChart(document.getElementById('ch-daily-billable'), {
    categories: daily.map(d => d.day),
    series: [
      { name: 'input',        values: daily.map(d => d.input_tokens),        color: '#4A9EFF' },
      { name: 'output',       values: daily.map(d => d.output_tokens),       color: '#7C5CFF' },
      { name: 'cache create', values: daily.map(d => d.cache_create_tokens), color: '#E8A23B' },
    ],
  });

  // Daily cache reads (separate — scale is 100× larger)
  stackedBarChart(document.getElementById('ch-daily-cache'), {
    categories: daily.map(d => d.day),
    series: [
      { name: 'cache read', values: daily.map(d => d.cache_read_tokens), color: '#3FB68B' },
    ],
  });

  // by-model doughnut
  donutChart(document.getElementById('ch-model'),
    byModel.map(m => ({
      name: fmt.modelShort(m.model) || 'unknown',
      value: (m.input_tokens || 0) + (m.output_tokens || 0)
           + (m.cache_create_5m_tokens || 0) + (m.cache_create_1h_tokens || 0),
    })).filter(d => d.value > 0),
  );

  // tokens by project — input vs output
  const topProjects = projects.slice(0, 8);
  groupedBarChart(document.getElementById('ch-projects'), {
    categories: topProjects.map(p => {
      const name = p.project_name || p.project_slug;
      return name.length > 20 ? name.slice(0, 19) + '…' : name;
    }),
    series: [
      { name: 'input',  values: topProjects.map(p => p.input_tokens  || 0), color: '#4A9EFF' },
      { name: 'output', values: topProjects.map(p => p.output_tokens || 0), color: '#7C5CFF' },
    ],
  });

  // top tools
  const topTools = tools.slice(0, 8);
  barChart(document.getElementById('ch-tools'), {
    categories: topTools.map(t => t.tool_name),
    values: topTools.map(t => t.calls),
    color: '#7C5CFF',
  });
}

function readWeeklyBudget() {
  const raw = localStorage.getItem('td.weekly-budget-usd');
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readPositiveNumber(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readUsageLimits() {
  const weeklyEnabled = localStorage.getItem('td.weekly-limit-enabled') !== '0';
  const weeklyTokens = readPositiveNumber('td.weekly-limit-tokens');
  return {
    sessionTokens: readPositiveNumber('td.session-limit-tokens'),
    weeklyTokens: weeklyEnabled ? weeklyTokens : null,
    weeklyConfigured: weeklyTokens,
    weeklyEnabled,
    cautionPct: readThreshold('td.weekly-caution-pct', 75),
    nearPct: readThreshold('td.weekly-near-pct', 90),
  };
}

function readThreshold(key, fallback) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value >= 1 && value <= 99 ? value : fallback;
}

function readWeekStartDay() {
  const raw = localStorage.getItem('td.week-start-day');
  if (raw == null || raw === '') return 1;
  const value = Number(raw);
  // Default assumption: dashboard weekly limits reset Monday at local 00:00.
  // This mirrors the existing weekly rollup language while allowing the
  // browser-local settings UI to change the boundary.
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 1;
}

function formatReset(reset) {
  return reset.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function usageProgressRow({ label, used, limit, status, meta, emptyText }) {
  const pct = progressPct(status);
  const value = limit ? `${fmt.compact(used)} / ${fmt.compact(limit)}` : fmt.compact(used);
  const sub = limit ? `${status.label} · ${fmt.int(used)} of ${fmt.int(limit)} tokens` : emptyText;
  return `
    <div class="limit-progress-row ${status.cls}">
      <div class="limit-progress-main">
        <div>
          <div class="limit-label">
            <span>${fmt.htmlSafe(label)}</span>
            ${limit ? `<span class="limit-state">${fmt.htmlSafe(status.name)}</span>` : ''}
          </div>
          <div class="limit-value" title="${fmt.htmlSafe(limit ? `${fmt.int(used)} of ${fmt.int(limit)} tokens` : `${fmt.int(used)} tokens`)}">${fmt.htmlSafe(value)}</div>
        </div>
        <div class="limit-meta">${fmt.htmlSafe(meta)}</div>
      </div>
      <div class="limit-meter" aria-label="${fmt.htmlSafe(label)} progress">
        <span style="width:${pct}%"></span>
      </div>
      <div class="limit-sub">${fmt.htmlSafe(sub)}</div>
    </div>`;
}

function usageMetric(label, value, sub = '', cls = '') {
  return `
    <div class="limit-metric ${cls}">
      <div class="label">${fmt.htmlSafe(label)}</div>
      <div class="value" title="${fmt.htmlSafe(String(value ?? '—'))}">${fmt.htmlSafe(String(value ?? '—'))}</div>
      ${sub ? `<div class="sub">${fmt.htmlSafe(sub)}</div>` : ''}
    </div>`;
}

function weeklyHistorySummary(trendWeeks, currentWeek, limits) {
  const rows = [...(trendWeeks || [])];
  const currentStart = currentWeek?.start_date;
  const currentIdx = rows.findIndex(w => w.start_date === currentStart);
  if (currentIdx >= 0) rows[currentIdx] = { ...rows[currentIdx], ...currentWeek };
  else if (currentWeek?.start_date) rows.push(currentWeek);
  const visible = rows.slice(-5);
  if (!visible.length) return '';
  const values = visible.map(w => billableTokens(w));
  const max = Math.max(...values, limits.weeklyTokens || 0, 1);
  const current = values[values.length - 1] || 0;
  const previous = values.length > 1 ? values[values.length - 2] : null;
  const delta = previous == null ? null : current - previous;
  const deltaTextValue = delta == null
    ? 'no prior week'
    : `${delta >= 0 ? '+' : ''}${fmt.compact(delta)} vs previous week`;
  const deltaClassValue = delta == null || delta === 0 ? '' : (delta > 0 ? 'near' : 'normal');
  return `
    <div class="limit-history">
      <div class="limit-history-head">
        <span>Weekly history</span>
        <span class="${deltaClassValue}">${fmt.htmlSafe(deltaTextValue)}</span>
      </div>
      <div class="limit-history-bars">
        ${visible.map((week, i) => {
          const value = values[i] || 0;
          const pct = Math.max(2, Math.round((value / max) * 100));
          const isCurrent = i === visible.length - 1;
          return `
            <div class="limit-history-bar ${isCurrent ? 'current' : ''}" title="${fmt.htmlSafe(`${week.start_date}: ${fmt.int(value)} tokens`)}">
              <span style="height:${pct}%"></span>
              <em>${fmt.htmlSafe(shortWeekLabel(week.start_date))}</em>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function shortWeekLabel(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return dateStr.slice(5);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function usageLimitsSection({ latestSession, currentWeek, weekWindow, trendWeeks, budget, limits, provider, sources }) {
  const currentTokens = latestSession ? billableTokens(latestSession) : 0;
  const currentStatus = limitStatus(currentTokens, limits.sessionTokens);
  const weeklyTokens = billableTokens(currentWeek);
  const weeklyStatus = limitStatus(weeklyTokens, limits.weeklyTokens, limits);
  const remainingTokens = limits.weeklyTokens == null ? null : Math.max(0, limits.weeklyTokens - weeklyTokens);
  const sessionHref = latestSession ? (
    '#/sessions/' + encodeURIComponent(latestSession.session_id) + (
      provider.key === 'all' ? '' : '?provider=' + encodeURIComponent(provider.key)
    )
  ) : '#/sessions';
  const partial = (sources.sources || []).some(s => !['ready', 'disabled'].includes(s.data_state || ''));
  const reset = formatReset(weekWindow.reset);
  const weeklyCost = budget
    ? `${fmt.usd(budget.current_week_cost_usd)} of ${fmt.usd(budget.weekly_budget_usd)}`
    : 'cost budget not set';
  const sessionMeta = latestSession
    ? `${fmt.providerLabel(latestSession.provider)} · started ${fmt.ts(latestSession.started_at || latestSession.started)}`
    : 'no scanned session';
  const weekMeta = `${fmt.ts(weekWindow.start.toISOString())} to ${reset}`;
  const weeklyUsedLabel = limits.weeklyTokens ? `${progressPct(weeklyStatus)}%` : '—';
  const remainingLabel = remainingTokens == null ? '—' : fmt.compact(remainingTokens);
  const warningText = weeklyLimitWarning(weeklyStatus, remainingTokens);
  return `
    <div class="card usage-limits">
      <div class="usage-limits-head">
        <div>
          <h3>Usage limits</h3>
          <p class="muted">Local thresholds for the selected provider scope. Usage is measured from scanned session logs.</p>
        </div>
        <a href="#/settings" class="button-link">Configure</a>
      </div>

      <div class="limit-panel">
        ${usageProgressRow({
          label: 'Current session',
          used: currentTokens,
          limit: limits.sessionTokens,
          status: currentStatus,
          meta: sessionMeta,
          emptyText: limits.sessionTokens ? 'no scanned session usage yet' : 'set a session token threshold',
        })}
        ${usageProgressRow({
          label: 'Current week',
          used: weeklyTokens,
          limit: limits.weeklyTokens,
          status: weeklyStatus,
          meta: weekMeta,
          emptyText: limits.weeklyEnabled ? weeklyCost : 'weekly limit disabled',
        })}
      </div>

      <div class="limit-metrics">
        ${usageMetric('Weekly used', weeklyUsedLabel, limits.weeklyTokens ? `${fmt.compact(weeklyTokens)} consumed` : (limits.weeklyEnabled ? 'set weekly token limit' : 'limit disabled'), weeklyStatus.cls)}
        ${usageMetric('Remaining', remainingLabel, remainingTokens == null ? (limits.weeklyEnabled ? 'weekly limit not set' : 'limit disabled') : 'tokens available', remainingTokens === 0 && limits.weeklyTokens ? 'exceeded' : 'normal')}
        ${usageMetric('Reset', reset, 'local time')}
      </div>

      ${warningText ? `<div class="limit-warning ${weeklyStatus.cls}">${fmt.htmlSafe(warningText)}</div>` : ''}

      ${weeklyHistorySummary(trendWeeks, {
        ...currentWeek,
        start_date: weekWindow.start.toISOString().slice(0, 10),
      }, limits)}

      <div class="usage-limits-foot">
        <a href="${sessionHref}">${latestSession ? 'Open current session' : 'View sessions'}</a>
        <span class="muted">${partial ? 'Data coverage is partial; remaining usage may be optimistic.' : `Current week: ${fmt.ts(weekWindow.start.toISOString())} to reset.`}</span>
      </div>
    </div>`;
}

function weeklyLimitWarning(status, remainingTokens) {
  if (!status || status.pct == null) return '';
  if (status.cls === 'exceeded') return 'Weekly limit exceeded. New usage will count beyond your configured allowance until reset.';
  if (status.cls === 'near') return `${fmt.compact(remainingTokens)} tokens remain before this weekly limit is reached.`;
  if (status.cls === 'caution') return 'Weekly usage is climbing. Keep an eye on large prompts, tool results, and long sessions.';
  return '';
}

function trendKpi(label, value, sub = '', cls = '') {
  return `
    <div class="card kpi trend-kpi">
      <div class="label">${fmt.htmlSafe(label)}</div>
      <div class="value" title="${fmt.htmlSafe(String(value ?? '—'))}">${fmt.htmlSafe(String(value ?? '—'))}</div>
      ${sub ? `<div class="delta ${cls}">${fmt.htmlSafe(sub)}</div>` : ''}
    </div>`;
}

function budgetKpi(budget) {
  if (!budget) {
    return trendKpi('Budget', '—', 'no threshold set');
  }
  const pct = budget.pct == null ? '—' : Math.round(budget.pct * 100) + '%';
  const cls = budget.status === 'over' ? 'down' : (budget.status === 'near' ? 'warn' : 'up');
  return trendKpi('Budget', pct, `${fmt.usd(budget.current_week_cost_usd)} of ${fmt.usd(budget.weekly_budget_usd)}`, cls);
}

function deltaClass(delta) {
  if (!delta || delta.absolute == null || delta.absolute === 0) return '';
  return delta.absolute > 0 ? 'up' : 'down';
}

function deltaText(delta, formatter = fmt.compact) {
  if (!delta || delta.absolute == null) return 'no previous week';
  const abs = delta.absolute || 0;
  const sign = abs > 0 ? '+' : '';
  const pct = delta.pct == null ? '' : ` (${sign}${Math.round(delta.pct * 100)}%)`;
  return `${sign}${formatter(abs)} vs prev${pct}`;
}

function driverRows(rows) {
  if (!rows.length) return '<tr><td colspan="3" class="muted">no weekly snapshot data yet</td></tr>';
  return rows.map(row => `
    <tr>
      <td>${fmt.htmlSafe(row.label || row.key)}</td>
      <td class="num">${fmt.compact(row.billable_tokens)}</td>
      <td class="num">${fmt.usd(row.cost_usd)}${row.cost_partial ? '<span class="muted">*</span>' : ''}</td>
    </tr>`).join('');
}

function costSubtitle(totals) {
  const notes = [];
  if (totals.cost_usd == null) {
    notes.push((totals.sessions || 0) ? 'missing pricing for all models' : 'no model usage in range');
  } else {
    notes.push('token-rate estimate');
  }
  if (totals.cost_partial) {
    const n = totals.unpriced_models || 0;
    notes.push(`partial: ${n} unpriced model${n === 1 ? '' : 's'}`);
  }
  if (totals.cost_estimated) {
    const n = totals.estimated_models || 0;
    notes.push(`tier-estimated: ${n} model${n === 1 ? '' : 's'}`);
  }
  const plan = planSubtitle();
  if (plan) notes.push(plan);
  return `<div class="sub">${notes.map(fmt.htmlSafe).join(' · ')}</div>`;
}

function planSubtitle() {
  if (!state.pricing || state.plan === 'api') return null;
  const p = state.pricing.plans[state.plan];
  if (!p || !p.monthly) return null;
  return `${p.label}: $${p.monthly}/mo subscription not included`;
}
