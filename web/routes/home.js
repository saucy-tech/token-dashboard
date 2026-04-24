import { api, fmt, state, readQuery } from '/web/app.js';

function sinceIsoDays(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function withApiParams(path, params) {
  const q = [];
  if (params.since) q.push('since=' + encodeURIComponent(params.since));
  if (params.until) q.push('until=' + encodeURIComponent(params.until));
  if (params.source) q.push('source=' + encodeURIComponent(params.source));
  if (!q.length) return path;
  return path + (path.includes('?') ? '&' : '?') + q.join('&');
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

function columnCard(meta, totals, emptyMsg) {
  const src = meta.id;
  const detail = `#/overview?source=${encodeURIComponent(src)}`;
  const sessions = `#/sessions?source=${encodeURIComponent(src)}`;
  const configured = meta.configured !== false;
  const reachable = meta.reachable;
  const rows = meta.message_rows || 0;

  let banner = '';
  if (src === 'codex' && !configured) {
    banner = '<p class="home-col-banner muted">Set <code class="mono">CODEX_PROJECTS_DIR</code> to your Codex JSONL root, then rescan. Same format as Claude Code sessions.</p>';
  } else if (!reachable && configured) {
    banner = `<p class="home-col-banner warn">Projects directory not found: <code class="mono">${fmt.htmlSafe(meta.projects_dir)}</code></p>`;
  } else if (rows === 0 && reachable) {
    banner = `<p class="home-col-banner muted">${emptyMsg}</p>`;
  }

  return `
    <section class="card home-col" data-source="${src}">
      <div class="home-col-head">
        <h2 style="margin:0;font-size:15px">${fmt.htmlSafe(meta.label)}</h2>
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
  const tab = readQuery('tab', 'split');
  const since7 = sinceIsoDays(7);
  const [meta, claudeT, codexT] = await Promise.all([
    api('/api/sources'),
    api(withApiParams('/api/overview', { since: since7, source: 'claude' })),
    api(withApiParams('/api/overview', { since: since7, source: 'codex' })),
  ]);
  const claudeMeta = meta.sources.find(s => s.id === 'claude') || {};
  const codexMeta = meta.sources.find(s => s.id === 'codex') || {};

  const sourcesStrip = `
    <div class="card sources-strip" style="margin-bottom:16px">
      <h3 style="margin:0 0 8px;font-size:13px">Data sources</h3>
      <ul class="sources-strip-list">
        ${meta.sources.map(s => {
          const ok = s.reachable && (s.id === 'claude' || s.configured);
          const st = !s.configured && s.id === 'codex' ? 'not configured'
            : !s.reachable ? 'path missing'
            : `${fmt.int(s.message_rows)} rows`;
          return `<li><span class="dot ${ok ? 'ok' : 'bad'}"></span><strong>${fmt.htmlSafe(s.label)}</strong>
            <span class="muted"> — ${fmt.htmlSafe(st)}</span>
            ${s.projects_dir ? `<div class="mono muted" style="font-size:11px;margin-top:2px">${fmt.htmlSafe(s.projects_dir)}</div>` : ''}
          </li>`;
        }).join('')}
      </ul>
      <p class="muted" style="margin:10px 0 0;font-size:11px">Configure Codex via environment variable; full paths also appear in Settings.</p>
    </div>`;

  const tabs = `
    <div class="home-tabs" role="tablist">
      <button type="button" data-tab="split" class="${tab === 'split' ? 'active' : ''}">Split</button>
      <button type="button" data-tab="claude" class="${tab === 'claude' ? 'active' : ''}">Claude</button>
      <button type="button" data-tab="codex" class="${tab === 'codex' ? 'active' : ''}">Codex</button>
    </div>`;

  const splitBody = `
    <div class="row cols-2 home-split">
      ${columnCard(claudeMeta, claudeT, 'No Claude sessions in range yet. Run Claude Code in this profile.')}
      ${columnCard(codexMeta, codexT, 'No Codex rows ingested yet. Point CODEX_PROJECTS_DIR at transcripts and wait for scan.')}
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
      const u = new URLSearchParams();
      if (t !== 'split') u.set('tab', t);
      const q = u.toString();
      location.hash = '#/home' + (q ? '?' + q : '');
    });
  });
}
