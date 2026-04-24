import {
  api,
  dataSourcePanel,
  fmt,
  optionalApi,
  readHashParam,
  state,
  withQuery,
} from '/web/app.js';

function sinceIsoDays(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function cacheCreate(t) {
  return (t.cache_create_5m_tokens || 0) + (t.cache_create_1h_tokens || 0);
}

function kpiStrip(totals, planHtml) {
  const cc = cacheCreate(totals);
  const k = (label, compactVal, fullVal, cls = '') => `
    <div class="card kpi ${cls}">
      <div class="label">${label}</div>
      <div class="value" title="${fullVal}">${compactVal}</div>
    </div>`;
  return `
    <div class="row cols-7 home-kpis">
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

function columnCard(sourceObj, totals, emptyMsg) {
  const src = sourceObj.provider || 'claude';
  const detail = `#/overview?provider=${encodeURIComponent(src)}`;
  const sessions = `#/sessions?provider=${encodeURIComponent(src)}`;
  const label = sourceObj.label || src;
  const rows = sourceObj.cached_messages ?? 0;
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

export default async function (root) {
  const tab = readHashParam('tab', 'split') || 'split';
  const since7 = sinceIsoDays(7);
  const [meta, claudeT, codexT] = await Promise.all([
    optionalApi('/api/sources', { sources: [] }),
    api(withQuery('/api/overview', { since: since7, provider: 'claude' })),
    api(withQuery('/api/overview', { since: since7, provider: 'codex' })),
  ]);
  const claudeMeta = meta.sources.find(s => s.provider === 'claude') || { provider: 'claude', label: 'Claude Code' };
  const codexMeta = meta.sources.find(s => s.provider === 'codex') || { provider: 'codex', label: 'Codex' };

  const sourcesStrip = dataSourcePanel(meta, { compact: true });

  const tabs = `
    <div class="home-tabs" role="tablist">
      <button type="button" data-tab="split" class="${tab === 'split' ? 'active' : ''}">Split</button>
      <button type="button" data-tab="claude" class="${tab === 'claude' ? 'active' : ''}">Claude</button>
      <button type="button" data-tab="codex" class="${tab === 'codex' ? 'active' : ''}">Codex</button>
    </div>`;

  const splitBody = `
    <div class="row cols-2 home-split">
      ${columnCard(claudeMeta, claudeT, 'No Claude sessions in range yet. Run Claude Code in this profile.')}
      ${columnCard(codexMeta, codexT, 'No Codex rows ingested yet. Scan a Codex log root and wait for refresh.')}
    </div>`;

  const single = (id, totals, m) => `
    <div class="home-single">
      ${columnCard(m, totals, id === 'claude' ? 'No Claude data yet.' : 'No Codex data yet.')}
    </div>`;

  let main = splitBody;
  if (tab === 'claude') main = single('claude', claudeT, claudeMeta);
  if (tab === 'codex') main = single('codex', codexT, codexMeta);

  root.innerHTML = `
    <div class="flex" style="margin-bottom:12px;align-items:center;flex-wrap:wrap;gap:10px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Agent summary</h2>
      <span class="muted" style="font-size:12px">Claude Code vs Codex · 7-day totals</span>
    </div>
    ${tabs}
    ${sourcesStrip}
    ${main}`;

  root.querySelectorAll('.home-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tab;
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      if (t === 'split') params.delete('tab');
      else params.set('tab', t);
      const q = params.toString();
      location.hash = '#/home' + (q ? '?' + q : '');
    });
  });
}
