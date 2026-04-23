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
import { barChart, donutChart, groupedBarChart, stackedBarChart } from '/web/charts.js';

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

  const [totals, projects, sessions, tools, daily, byModel, providers, sources] = await Promise.all([
    api(withQuery('/api/overview', params)),
    api(withQuery('/api/projects', params)),
    api(withQuery('/api/sessions', { ...params, limit: 10 })),
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
