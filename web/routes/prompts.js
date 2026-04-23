import {
  api,
  exportHref,
  fmt,
  providerTabs,
  readHashParam,
  readProvider,
  withQuery,
  writeHashParams,
} from '/web/app.js';

const SORTS = [
  { key: 'tokens', label: 'Most tokens' },
  { key: 'recent', label: 'Most recent' },
];

function readSort() {
  const k = readHashParam('sort');
  return SORTS.find(s => s.key === k) || SORTS[0];
}

function writeSort(key) {
  writeHashParams({ sort: key });
}

function writeProvider(key) {
  writeHashParams({ provider: key === 'all' ? null : key });
}

function sessionHref(sessionId, provider) {
  return '#/sessions/' + encodeURIComponent(sessionId) + (
    provider.key === 'all' ? '' : '?provider=' + encodeURIComponent(provider.key)
  );
}

export default async function (root) {
  const sort = readSort();
  const provider = readProvider();
  const rows = await api(withQuery('/api/prompts', {
    limit: 100,
    sort: sort.key,
    provider: provider.key === 'all' ? null : provider.key,
  }));

  const sortTabs = `
    <div class="range-tabs" role="tablist">
      ${SORTS.map(s => `<button data-sort="${s.key}" class="${s.key === sort.key ? 'active' : ''}">${s.label}</button>`).join('')}
    </div>`;

  const subtitle = sort.key === 'recent'
    ? 'Your latest prompts and the assistant turn each one triggered. Click a row to see the full prompt.'
    : 'The prompts that used the most billable tokens. Cache-read cost is shown only when the model has pricing.';
  const selectedProvider = provider.key === 'all' ? 'all providers' : fmt.providerLabel(provider.key);
  const exportParams = {
    limit: 100,
    sort: sort.key,
    provider: provider.key === 'all' ? null : provider.key,
  };

  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Prompts</h2>
      <div class="spacer"></div>
      ${sortTabs}
    </div>

    <div class="flex" style="margin:-4px 0 16px;justify-content:flex-end">
      ${providerTabs(provider.key)}
    </div>

    <div class="card">
      <div class="flex" style="margin:0 0 14px;align-items:flex-start">
        <p class="muted" style="margin:0">${subtitle} Showing ${fmt.htmlSafe(selectedProvider)}.</p>
        <span class="spacer"></span>
        <div class="export-actions">
          <a href="${exportHref('prompts', 'csv', exportParams)}" class="button-link">Export CSV</a>
          <a href="${exportHref('prompts', 'json', exportParams)}" class="button-link">Export JSON</a>
        </div>
      </div>
      <table id="prompts">
        <thead><tr>
          <th>${sort.key === 'recent' ? 'when' : 'cache-read cost'}</th>
          <th>prompt</th>
          <th>provider</th>
          <th>model</th>
          <th class="num">tokens</th>
          <th class="num">cache rd</th>
          <th>session</th>
        </tr></thead>
        <tbody>
          ${rows.map((r,i) => `
            <tr data-i="${i}" style="cursor:pointer">
              <td class="${sort.key === 'recent' ? 'mono' : 'num mono'}">${sort.key === 'recent' ? fmt.ts(r.timestamp) : promptCost(r)}</td>
              <td class="blur-sensitive">${fmt.htmlSafe(fmt.short(r.prompt_text, 110))}</td>
              <td><span class="badge ${fmt.providerClass(r.provider)}">${fmt.htmlSafe(fmt.providerLabel(r.provider))}</span></td>
              <td><span class="badge ${fmt.modelClass(r.model)}">${fmt.htmlSafe(fmt.modelShort(r.model))}</span></td>
              <td class="num">${fmt.int(r.billable_tokens)}</td>
              <td class="num">${fmt.int(r.cache_read_tokens)}</td>
              <td><a href="${sessionHref(r.session_id, provider)}" class="mono" onclick="event.stopPropagation()">${fmt.htmlSafe(fmt.sessionShort(r.session_id))}</a></td>
            </tr>`).join('') || '<tr><td colspan="7" class="muted">no prompts yet</td></tr>'}
        </tbody>
      </table>
    </div>
    <div id="drawer"></div>
  `;

  root.querySelectorAll('.range-tabs button').forEach(btn => {
    if (btn.dataset.sort) btn.addEventListener('click', () => writeSort(btn.dataset.sort));
    if (btn.dataset.provider) btn.addEventListener('click', () => writeProvider(btn.dataset.provider));
  });

  root.querySelectorAll('#prompts tbody tr[data-i]').forEach(tr => {
    tr.addEventListener('click', () => {
      const r = rows[Number(tr.dataset.i)];
      const drawer = document.getElementById('drawer');
      drawer.innerHTML = `
        <div class="card">
          <h3 style="display:flex;align-items:center">
            <span>Prompt detail</span>
            <span class="spacer"></span>
            <span class="badge ${fmt.providerClass(r.provider)}">${fmt.htmlSafe(fmt.providerLabel(r.provider))}</span>
            <span class="badge ${fmt.modelClass(r.model)}">${fmt.htmlSafe(fmt.modelShort(r.model))}</span>
          </h3>
          <pre class="blur-sensitive">${fmt.htmlSafe(r.prompt_text || '')}</pre>
          <div class="flex" style="margin-top:12px;flex-wrap:wrap;gap:14px">
            <span class="muted">${fmt.ts(r.timestamp)}</span>
            <span class="muted">${fmt.int(r.billable_tokens)} billable · ${fmt.int(r.cache_read_tokens)} cache rd · ${promptCostDetail(r)}</span>
            <span class="spacer"></span>
            <a href="${sessionHref(r.session_id, provider)}">Open session →</a>
          </div>
        </div>`;
      drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}

function promptCost(r) {
  if (r.estimated_cost_usd == null) return '<span class="muted">not priced</span>';
  return `${r.estimated_cost_estimated ? '~' : ''}${fmt.usd4(r.estimated_cost_usd)}`;
}

function promptCostDetail(r) {
  if (r.estimated_cost_usd == null) return 'cache-read cost not priced';
  const prefix = r.estimated_cost_estimated ? 'tier-estimated ' : '';
  return `${prefix}${fmt.usd4(r.estimated_cost_usd)} cache-read cost`;
}
