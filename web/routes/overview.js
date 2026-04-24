import { api, fmt, state, readQuery } from '/web/app.js';
import { barChart, donutChart, groupedBarChart, stackedBarChart } from '/web/charts.js';

const RANGES = [
  { key: '7d',  label: '7d',  days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: 'All', days: null },
];

function readRange() {
  const k = readQuery('range', '');
  return RANGES.find(r => r.key === k) || RANGES[1];
}

function readSource() {
  const s = readQuery('source', '').trim().toLowerCase();
  if (s === 'claude' || s === 'codex') return s;
  return '';
}

function writeOverviewRange(key) {
  const params = new URLSearchParams();
  params.set('range', key);
  const src = readSource();
  if (src) params.set('source', src);
  location.hash = '#/overview?' + params.toString();
}

function sinceIsoDays(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function localTodayBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { since: start.toISOString(), until: end.toISOString() };
}

function withParams(path, { since, until, source, limit } = {}) {
  const q = [];
  if (since) q.push('since=' + encodeURIComponent(since));
  if (until) q.push('until=' + encodeURIComponent(until));
  if (source) q.push('source=' + encodeURIComponent(source));
  if (limit != null && limit !== '') q.push('limit=' + encodeURIComponent(String(limit)));
  if (!q.length) return path;
  return path + (path.includes('?') ? '&' : '?') + q.join('&');
}

function cacheCreate(totals) {
  return (totals.cache_create_5m_tokens || 0) + (totals.cache_create_1h_tokens || 0);
}

function kpiRow(totals, planHtml) {
  const cc = cacheCreate(totals);
  const k = (label, compactVal, fullVal, cls = '') => `
    <div class="card kpi ${cls}">
      <div class="label">${label}</div>
      <div class="value" title="${fullVal}">${compactVal}</div>
    </div>`;
  return `
    <div class="row cols-7">
      ${k('Sessions', fmt.int(totals.sessions), fmt.int(totals.sessions))}
      ${k('Turns', fmt.int(totals.turns), fmt.int(totals.turns))}
      ${k('Input', fmt.compact(totals.input_tokens), fmt.int(totals.input_tokens) + ' tokens')}
      ${k('Output', fmt.compact(totals.output_tokens), fmt.int(totals.output_tokens) + ' tokens')}
      ${k('Cache read', fmt.compact(totals.cache_read_tokens), fmt.int(totals.cache_read_tokens) + ' tokens')}
      ${k('Cache create', fmt.compact(cc), fmt.int(cc) + ' tokens')}
      <div class="card kpi cost">
        <div class="label">Est. cost</div>
        <div class="value" title="${fmt.usd(totals.cost_usd)}">${fmt.usd(totals.cost_usd)}</div>
        ${planHtml}
      </div>
    </div>`;
}

function planSubtitle() {
  if (!state.pricing || state.plan === 'api') return '';
  const p = state.pricing.plans[state.plan];
  if (!p || !p.monthly) return '';
  return `<div class="sub">pay $${p.monthly}/mo on ${fmt.htmlSafe(p.label)}</div>`;
}

function sourceBadge(src) {
  if (!src) return '';
  const label = src === 'claude' ? 'Claude Code' : 'Codex';
  return `<span class="pill" style="margin-left:8px">${fmt.htmlSafe(label)}</span>`;
}

export default async function (root) {
  const range = readRange();
  const src = readSource();
  const srcParam = src || undefined;
  const sinceCharts = range.days ? sinceIsoDays(range.days) : null;

  const today = localTodayBounds();
  const sinceWeek = sinceIsoDays(7);

  const fetches = [
    api(withParams('/api/overview', { since: sinceWeek, source: srcParam })),
    api(withParams('/api/overview', { since: today.since, until: today.until, source: srcParam })),
    api(withParams('/api/sessions', { source: srcParam, limit: 1 })),
    api(withParams('/api/projects', { since: sinceCharts, source: srcParam })),
    api(withParams('/api/sessions', { since: sinceCharts, source: srcParam, limit: 10 })),
    api(withParams('/api/tools', { since: sinceCharts, source: srcParam })),
    api(withParams('/api/daily', { since: sinceCharts, source: srcParam })),
    api(withParams('/api/by-model', { since: sinceCharts, source: srcParam })),
  ];

  const [
    totalsWeek,
    totalsToday,
    latestList,
    projects,
    sessions,
    tools,
    daily,
    byModel,
  ] = await Promise.all(fetches);

  const latest = (latestList && latestList[0]) || null;
  const srcQs = src ? `?source=${encodeURIComponent(src)}` : '';
  const latestLink = latest
    ? `#/sessions/${encodeURIComponent(latest.session_id)}${srcQs}`
    : '#/sessions' + (src ? `?source=${encodeURIComponent(src)}` : '');

  const rangeTabs = `
    <div class="range-tabs" role="tablist" title="Applies to charts inside “Exploratory analytics”">
      ${RANGES.map(r => `<button type="button" data-range="${r.key}" class="${r.key === range.key ? 'active' : ''}">${r.label}</button>`).join('')}
    </div>`;

  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px;flex-wrap:wrap;gap:10px;align-items:center">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Overview</h2>
      ${sourceBadge(src)}
      <span class="muted" style="font-size:12px">primary: this week · today · latest session</span>
      <div class="spacer"></div>
      <span class="muted" style="font-size:11px">chart range</span>
      ${rangeTabs}
    </div>

    <section class="overview-section card" style="margin-bottom:14px">
      <h3 class="overview-h3">This week</h3>
      <p class="muted" style="margin:-4px 0 12px;font-size:12px">Rolling last 7 days (not tied to the chart range below).</p>
      ${kpiRow(totalsWeek, planSubtitle())}
    </section>

    <section class="overview-section card" style="margin-bottom:14px">
      <h3 class="overview-h3">Today</h3>
      <p class="muted" style="margin:-4px 0 12px;font-size:12px">Local calendar day (${fmt.ts(today.since).slice(0, 10)}).</p>
      ${kpiRow(totalsToday, '')}
    </section>

    <section class="overview-section card" style="margin-bottom:14px">
      <h3 class="overview-h3">Latest scanned session</h3>
      <p class="muted" style="margin:-4px 0 10px;font-size:12px">Most recently active session in the database.</p>
      ${latest ? `
        <table class="latest-session-table">
          <thead><tr><th>started</th><th>project</th><th class="num">turns</th><th class="num">tokens</th><th></th></tr></thead>
          <tbody>
            <tr>
              <td class="mono">${fmt.ts(latest.started)}</td>
              <td>${fmt.htmlSafe(latest.project_name || latest.project_slug)}</td>
              <td class="num">${fmt.int(latest.turns)}</td>
              <td class="num">${fmt.compact(latest.tokens)}</td>
              <td><a href="${latestLink}">Open →</a></td>
            </tr>
          </tbody>
        </table>` : `<p class="muted">No sessions yet.</p>`}
    </section>

    <details class="card charts-details" id="ov-charts-details" style="margin-bottom:14px">
      <summary><strong>Exploratory analytics</strong><span class="muted" style="font-weight:400;font-size:12px;margin-left:8px">— daily trends, projects, models, tools, recent sessions (${range.days ? `last ${range.days}d` : 'all time'})</span></summary>
      <div style="margin-top:16px">
        <div class="row cols-2" style="margin-top:0">
          <div class="card flat-nested">
            <h3>Your daily work</h3>
            <p class="muted" style="margin:-4px 0 10px;font-size:12px">Billable stack: input, output, cache create.</p>
            <div id="ch-daily-billable" style="height:260px"></div>
          </div>
          <div class="card flat-nested">
            <h3>Daily cache reads</h3>
            <p class="muted" style="margin:-4px 0 10px;font-size:12px">Cheap re-use of prior context.</p>
            <div id="ch-daily-cache" style="height:260px"></div>
          </div>
        </div>
        <div class="row cols-2" style="margin-top:16px">
          <div class="card flat-nested"><h3>Tokens by project</h3><div id="ch-projects" style="height:320px"></div></div>
          <div class="card flat-nested">
            <h3>Token usage by model</h3>
            <p class="muted" style="margin:-4px 0 4px;font-size:12px">Share of billable tokens per model.</p>
            <div id="ch-model" style="height:300px"></div>
          </div>
        </div>
        <div class="row cols-2" style="margin-top:16px">
          <div class="card flat-nested"><h3>Top tools (by call count)</h3><div id="ch-tools" style="height:320px"></div></div>
          <div class="card flat-nested">
            <h3 style="display:flex;align-items:center"><span>Recent sessions</span><span class="spacer"></span><a href="#/sessions${src ? `?source=${encodeURIComponent(src)}` : ''}" style="font-weight:400;font-size:12px">all →</a></h3>
            <table>
              <thead><tr><th>started</th><th>project</th><th class="num">tokens</th></tr></thead>
              <tbody>
                ${sessions.map(s => `
                  <tr>
                    <td class="mono">${fmt.ts(s.started)}</td>
                    <td><a href="#/sessions/${encodeURIComponent(s.session_id)}${srcQs}">${fmt.htmlSafe(s.project_name || s.project_slug)}</a></td>
                    <td class="num">${fmt.compact(s.tokens)}</td>
                  </tr>`).join('') || '<tr><td colspan="3" class="muted">no sessions in this range</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </details>

    <details class="card glossary">
      <summary><h3 style="display:inline-block;margin:0">What do these numbers mean?</h3><span class="muted" style="font-size:12px"> — click to expand</span></summary>
      <dl>
        <dt>Session</dt><dd>One agent run; each session is a single <code>.jsonl</code> file.</dd>
        <dt>Turn</dt><dd>One user message (each turn triggers a response, possibly with tool calls).</dd>
        <dt>Input tokens</dt><dd>New text you (and tool results) sent this turn.</dd>
        <dt>Output tokens</dt><dd>Text the model wrote back — often the main cost driver.</dd>
        <dt>Cache read</dt><dd>Re-used context; billed much less than fresh input.</dd>
        <dt>Cache create</dt><dd>One-time cost to write context into the cache.</dd>
        <dt>Billable tokens</dt><dd>Input + output + cache create (reads billed separately).</dd>
      </dl>
    </details>
  `;

  root.querySelectorAll('.range-tabs button').forEach(btn => {
    btn.addEventListener('click', () => writeOverviewRange(btn.dataset.range));
  });

  const chartsEl = root.querySelector('#ov-charts-details');
  let chartsInited = false;

  function mountCharts() {
    if (chartsInited) return;
    chartsInited = true;
    stackedBarChart(document.getElementById('ch-daily-billable'), {
      categories: daily.map(d => d.day),
      series: [
        { name: 'input',        values: daily.map(d => d.input_tokens),        color: '#4A9EFF' },
        { name: 'output',       values: daily.map(d => d.output_tokens),       color: '#7C5CFF' },
        { name: 'cache create', values: daily.map(d => d.cache_create_tokens), color: '#E8A23B' },
      ],
    });
    stackedBarChart(document.getElementById('ch-daily-cache'), {
      categories: daily.map(d => d.day),
      series: [{ name: 'cache read', values: daily.map(d => d.cache_read_tokens), color: '#3FB68B' }],
    });
    donutChart(document.getElementById('ch-model'),
      byModel.map(m => ({
        name: fmt.modelShort(m.model) || 'unknown',
        value: (m.input_tokens || 0) + (m.output_tokens || 0)
             + (m.cache_create_5m_tokens || 0) + (m.cache_create_1h_tokens || 0),
      })).filter(d => d.value > 0),
    );
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
    const topTools = tools.slice(0, 8);
    barChart(document.getElementById('ch-tools'), {
      categories: topTools.map(t => t.tool_name),
      values: topTools.map(t => t.calls),
      color: '#7C5CFF',
    });
  }

  if (chartsEl?.open) {
    requestAnimationFrame(mountCharts);
  }
  chartsEl?.addEventListener('toggle', () => {
    if (chartsEl.open) requestAnimationFrame(mountCharts);
  });
}
