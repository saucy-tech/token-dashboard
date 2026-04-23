import {
  api,
  fmt,
  readHashParam,
  withQuery,
  writeHashParams,
} from '/web/app.js';
import { donutChart, groupedBarChart, lineChart } from '/web/charts.js';

const RANGES = [
  { key: '7d',  label: '7d',  days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: 'All', days: null },
];

const PROVIDERS = [
  { key: 'claude', label: 'Claude', color: '#F6B26B' },
  { key: 'codex', label: 'Codex', color: '#6FD1C2' },
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

function emptyProvider(key) {
  return {
    provider: key,
    sessions: 0,
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_create_5m_tokens: 0,
    cache_create_1h_tokens: 0,
  };
}

function cacheCreate(row) {
  return (row.cache_create_5m_tokens || 0) + (row.cache_create_1h_tokens || 0);
}

function billable(row) {
  return (row.input_tokens || 0) + (row.output_tokens || 0) + cacheCreate(row);
}

function dailyBillable(row) {
  return (row.input_tokens || 0) + (row.output_tokens || 0) + (row.cache_create_tokens || 0);
}

function pctOfTotal(value, total) {
  if (!total) return '-';
  return Math.round((value / total) * 100) + '%';
}

function deltaText(claudeValue, codexValue, formatter = fmt.int) {
  const diff = (claudeValue || 0) - (codexValue || 0);
  if (!diff) return 'even';
  return `${diff > 0 ? 'Claude' : 'Codex'} +${formatter(Math.abs(diff))}`;
}

function deltaClass(claudeValue, codexValue) {
  const diff = (claudeValue || 0) - (codexValue || 0);
  return diff >= 0 ? 'provider-claude' : 'provider-codex';
}

function byDay(rows) {
  return new Map((rows || []).map(r => [r.day, r]));
}

function modelValue(row) {
  return billable(row);
}

function compactName(model) {
  const name = fmt.modelShort(model || 'unknown');
  return name.length > 26 ? name.slice(0, 25) + '...' : name;
}

export default async function (root) {
  const range = readRange();
  const since = sinceIso(range);
  const params = { since };

  const [providers, claudeDaily, codexDaily, claudeModels, codexModels] = await Promise.all([
    api(withQuery('/api/providers', params)),
    api(withQuery('/api/daily', { ...params, provider: 'claude' })),
    api(withQuery('/api/daily', { ...params, provider: 'codex' })),
    api(withQuery('/api/by-model', { ...params, provider: 'claude' })),
    api(withQuery('/api/by-model', { ...params, provider: 'codex' })),
  ]);

  const providerRows = new Map(providers.map(p => [String(p.provider || '').toLowerCase(), p]));
  const claude = providerRows.get('claude') || emptyProvider('claude');
  const codex = providerRows.get('codex') || emptyProvider('codex');
  const totals = {
    sessions: (claude.sessions || 0) + (codex.sessions || 0),
    turns: (claude.turns || 0) + (codex.turns || 0),
    billable: billable(claude) + billable(codex),
    cacheRead: (claude.cache_read_tokens || 0) + (codex.cache_read_tokens || 0),
  };

  const metricRows = [
    { label: 'Sessions', claude: claude.sessions || 0, codex: codex.sessions || 0, formatter: fmt.int, total: totals.sessions },
    { label: 'Turns', claude: claude.turns || 0, codex: codex.turns || 0, formatter: fmt.int, total: totals.turns },
    { label: 'Billable tokens', claude: billable(claude), codex: billable(codex), formatter: fmt.int, total: totals.billable },
    { label: 'Cache reads', claude: claude.cache_read_tokens || 0, codex: codex.cache_read_tokens || 0, formatter: fmt.int, total: totals.cacheRead },
    {
      label: 'Billable / turn',
      claude: claude.turns ? Math.round(billable(claude) / claude.turns) : 0,
      codex: codex.turns ? Math.round(billable(codex) / codex.turns) : 0,
      formatter: fmt.int,
      total: null,
    },
  ];

  const claudeDays = byDay(claudeDaily);
  const codexDays = byDay(codexDaily);
  const days = Array.from(new Set([
    ...claudeDaily.map(d => d.day),
    ...codexDaily.map(d => d.day),
  ])).sort();
  const claudeDailyBillable = days.map(day => dailyBillable(claudeDays.get(day) || {}));
  const codexDailyBillable = days.map(day => dailyBillable(codexDays.get(day) || {}));
  const claudeCacheRead = days.map(day => (claudeDays.get(day) || {}).cache_read_tokens || 0);
  const codexCacheRead = days.map(day => (codexDays.get(day) || {}).cache_read_tokens || 0);
  const billableDelta = days.map((_, i) => claudeDailyBillable[i] - codexDailyBillable[i]);
  const cacheDelta = days.map((_, i) => claudeCacheRead[i] - codexCacheRead[i]);

  const modelNames = Array.from(new Set([
    ...claudeModels.map(m => m.model || 'unknown'),
    ...codexModels.map(m => m.model || 'unknown'),
  ]));
  const claudeByModel = new Map(claudeModels.map(m => [m.model || 'unknown', m]));
  const codexByModel = new Map(codexModels.map(m => [m.model || 'unknown', m]));
  const modelRows = modelNames.map(model => ({
    model,
    claude: modelValue(claudeByModel.get(model) || {}),
    codex: modelValue(codexByModel.get(model) || {}),
  })).sort((a, b) => (b.claude + b.codex) - (a.claude + a.codex));

  const rangeTabs = `
    <div class="range-tabs" role="tablist">
      ${RANGES.map(r => `<button data-range="${r.key}" class="${r.key === range.key ? 'active' : ''}">${r.label}</button>`).join('')}
    </div>`;

  const providerCard = (provider, row, shareBase) => `
    <div class="card provider-compare-card">
      <h3 style="display:flex;align-items:center">
        <span>${provider.label}</span>
        <span class="spacer"></span>
        <span class="badge ${fmt.providerClass(provider.key)}">${provider.key}</span>
      </h3>
      <div class="provider-total" title="${fmt.int(billable(row))} billable tokens">${fmt.compact(billable(row))}</div>
      <div class="muted" style="font-size:12px;margin-top:2px">billable tokens &middot; ${pctOfTotal(billable(row), shareBase)} share</div>
      <div class="provider-card-grid">
        <span>${fmt.int(row.sessions)} sessions</span>
        <span>${fmt.int(row.turns)} turns</span>
        <span>${fmt.compact(row.cache_read_tokens)} cache rd</span>
        <span>${row.turns ? fmt.compact(Math.round(billable(row) / row.turns)) : '0'} / turn</span>
      </div>
    </div>`;

  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Claude vs. Codex</h2>
      <span class="muted" style="font-size:12px">${range.days ? `last ${range.days} days` : 'all time'}</span>
      <div class="spacer"></div>
      ${rangeTabs}
    </div>

    <div class="row cols-3">
      ${providerCard(PROVIDERS[0], claude, totals.billable)}
      ${providerCard(PROVIDERS[1], codex, totals.billable)}
      <div class="card provider-compare-card">
        <h3>Deltas</h3>
        <div class="delta-stack">
          ${metricRows.slice(0, 4).map(r => `
            <div>
              <span class="muted">${r.label}</span>
              <strong class="badge ${deltaClass(r.claude, r.codex)}">${deltaText(r.claude, r.codex, r.formatter)}</strong>
            </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Metric comparison</h3>
      <table>
        <thead><tr><th>metric</th><th class="num">Claude</th><th class="num">Codex</th><th class="num">delta</th><th class="num">Claude share</th><th class="num">Codex share</th></tr></thead>
        <tbody>
          ${metricRows.map(r => `
            <tr>
              <td>${r.label}</td>
              <td class="num">${r.formatter(r.claude)}</td>
              <td class="num">${r.formatter(r.codex)}</td>
              <td class="num"><span class="badge ${deltaClass(r.claude, r.codex)}">${deltaText(r.claude, r.codex, r.formatter)}</span></td>
              <td class="num">${r.total == null ? '-' : pctOfTotal(r.claude, r.total)}</td>
              <td class="num">${r.total == null ? '-' : pctOfTotal(r.codex, r.total)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="row cols-2" style="margin-top:16px">
      <div class="card">
        <h3>Daily billable usage</h3>
        <div id="ch-daily-billable-provider" style="height:280px"></div>
      </div>
      <div class="card">
        <h3>Daily cache reads</h3>
        <div id="ch-daily-cache-provider" style="height:280px"></div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Daily delta</h3>
      <p class="muted" style="margin:-4px 0 8px;font-size:12px">Positive values mean Claude used more that day; negative values mean Codex used more.</p>
      <div id="ch-daily-delta" style="height:280px"></div>
    </div>

    <div class="row cols-2" style="margin-top:16px">
      <div class="card">
        <h3>Claude model mix</h3>
        <div id="ch-claude-models" style="height:300px"></div>
      </div>
      <div class="card">
        <h3>Codex model mix</h3>
        <div id="ch-codex-models" style="height:300px"></div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Model mix deltas</h3>
      <table>
        <thead><tr><th>model</th><th class="num">Claude billable</th><th class="num">Codex billable</th><th class="num">delta</th></tr></thead>
        <tbody>
          ${modelRows.map(r => `
            <tr>
              <td><span class="badge ${fmt.modelClass(r.model)}">${fmt.htmlSafe(fmt.modelShort(r.model))}</span></td>
              <td class="num">${fmt.int(r.claude)}</td>
              <td class="num">${fmt.int(r.codex)}</td>
              <td class="num"><span class="badge ${deltaClass(r.claude, r.codex)}">${deltaText(r.claude, r.codex, fmt.int)}</span></td>
            </tr>`).join('') || '<tr><td colspan="4" class="muted">no Claude or Codex model data in this range</td></tr>'}
        </tbody>
      </table>
    </div>
  `;

  root.querySelectorAll('.range-tabs button').forEach(btn => {
    btn.addEventListener('click', () => writeRange(btn.dataset.range));
  });

  groupedBarChart(document.getElementById('ch-daily-billable-provider'), {
    categories: days,
    series: [
      { name: 'Claude', values: claudeDailyBillable, color: PROVIDERS[0].color },
      { name: 'Codex', values: codexDailyBillable, color: PROVIDERS[1].color },
    ],
  });

  groupedBarChart(document.getElementById('ch-daily-cache-provider'), {
    categories: days,
    series: [
      { name: 'Claude', values: claudeCacheRead, color: PROVIDERS[0].color },
      { name: 'Codex', values: codexCacheRead, color: PROVIDERS[1].color },
    ],
  });

  lineChart(document.getElementById('ch-daily-delta'), {
    x: days,
    series: [
      { name: 'billable delta', data: billableDelta, color: '#4A9EFF' },
      { name: 'cache read delta', data: cacheDelta, color: '#3FB68B' },
    ],
  });

  donutChart(
    document.getElementById('ch-claude-models'),
    claudeModels.map(m => ({
      name: compactName(m.model),
      value: modelValue(m),
    })).filter(d => d.value > 0),
  );

  donutChart(
    document.getElementById('ch-codex-models'),
    codexModels.map(m => ({
      name: compactName(m.model),
      value: modelValue(m),
    })).filter(d => d.value > 0),
  );
}
