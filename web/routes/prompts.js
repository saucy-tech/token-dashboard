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

const PAGE_SIZE = 50;
let _page = 0;
let _promptScopeKey = '';

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
  const scopeKey = `${sort.key}|${provider.key}`;
  if (scopeKey !== _promptScopeKey) {
    _promptScopeKey = scopeKey;
    _page = 0;
  }
  const selectedPrompt = readHashParam('prompt');
  const rows = await api(withQuery('/api/prompts', {
    limit: PAGE_SIZE,
    offset: 0,
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
    limit: 1000,
    sort: sort.key,
    provider: provider.key === 'all' ? null : provider.key,
  };
  const hasMoreInitial = rows.length === PAGE_SIZE;

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
          <th>why</th>
          <th>provider</th>
          <th>model</th>
          <th class="num">tokens</th>
          <th class="num">cache rd</th>
          <th>session</th>
        </tr></thead>
        <tbody id="prompts-body">
          ${rows.length ? rows.map((r, i) => promptRow(r, i, sort, provider)).join('') : '<tr id="prompts-empty"><td colspan="8" class="muted">no prompts yet</td></tr>'}
        </tbody>
      </table>
      <div style="margin-top:12px">
        <button class="ghost" id="prompts-load-more" ${hasMoreInitial ? '' : 'hidden'}>Load 50 more</button>
      </div>
    </div>
    <div id="drawer"></div>
  `;

  root.querySelectorAll('.range-tabs button').forEach(btn => {
    if (btn.dataset.sort) btn.addEventListener('click', () => writeSort(btn.dataset.sort));
    if (btn.dataset.provider) btn.addEventListener('click', () => writeProvider(btn.dataset.provider));
  });

  function openPrompt(index) {
    const r = rows[Number(index)];
    if (!r) return;
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
          <div class="prompt-why">
            <h3>Why this was expensive</h3>
            <p>${fmt.htmlSafe(r.why_expensive || 'Token use came mostly from the assistant turn itself.')}</p>
            ${Array.isArray(r.cost_drivers) && r.cost_drivers.length ? `
              <table class="tool-detail-table">
                <thead><tr><th>tool</th><th>target</th><th class="num">calls</th><th class="num">result tokens</th></tr></thead>
                <tbody>
                  ${r.cost_drivers.map(d => `
                    <tr>
                      <td><span class="badge">${fmt.htmlSafe(d.tool_name)}</span></td>
                      <td class="blur-sensitive">${fmt.htmlSafe(fmt.short(d.target || '', 90))}</td>
                      <td class="num">${fmt.int(d.calls)}</td>
                      <td class="num">${fmt.int(d.result_tokens)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>` : ''}
          </div>
          <div class="flex" style="margin-top:12px;flex-wrap:wrap;gap:14px">
            <span class="muted">${fmt.ts(r.timestamp)}</span>
            <span class="muted">${fmt.int(r.billable_tokens)} billable · ${fmt.int(r.cache_read_tokens)} cache rd · ${promptCostDetail(r)}</span>
            <span class="spacer"></span>
            <a href="${sessionHref(r.session_id, provider)}">Open session →</a>
          </div>
        </div>`;
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const promptBody = root.querySelector('#prompts-body');
  const loadMore = root.querySelector('#prompts-load-more');
  if (promptBody) {
    promptBody.addEventListener('click', event => {
      const row = event.target.closest('tr[data-i]');
      if (!row) return;
      openPrompt(row.dataset.i);
      setSelectedPromptRow(promptBody, row.dataset.i);
    });
  }

  if (loadMore) {
    loadMore.addEventListener('click', async () => {
      _page += 1;
      const next = await api(withQuery('/api/prompts', {
        limit: PAGE_SIZE,
        offset: _page * PAGE_SIZE,
        sort: sort.key,
        provider: provider.key === 'all' ? null : provider.key,
      }));
      if (!next.length) {
        loadMore.hidden = true;
        return;
      }
      const empty = promptBody?.querySelector('#prompts-empty');
      if (empty) empty.remove();
      const startIndex = rows.length;
      rows.push(...next);
      promptBody?.insertAdjacentHTML(
        'beforeend',
        next.map((row, idx) => promptRow(row, startIndex + idx, sort, provider)).join(''),
      );
      if (next.length < PAGE_SIZE) loadMore.hidden = true;
    });
  }

  if (selectedPrompt) {
    const index = rows.findIndex(r => r.user_uuid === selectedPrompt);
    if (index >= 0) {
      openPrompt(index);
      setSelectedPromptRow(promptBody, String(index));
    }
  }
}

function promptRow(r, index, sort, provider) {
  return `<tr data-i="${index}" data-prompt="${fmt.htmlSafe(r.user_uuid)}" style="cursor:pointer">
    <td class="${sort.key === 'recent' ? 'mono' : 'num mono'}">${sort.key === 'recent' ? fmt.ts(r.timestamp) : promptCost(r)}</td>
    <td class="blur-sensitive">${fmt.htmlSafe(fmt.short(r.prompt_text, 110))}</td>
    <td>${fmt.htmlSafe(fmt.short(r.why_expensive || '', 90))}</td>
    <td><span class="badge ${fmt.providerClass(r.provider)}">${fmt.htmlSafe(fmt.providerLabel(r.provider))}</span></td>
    <td><span class="badge ${fmt.modelClass(r.model)}">${fmt.htmlSafe(fmt.modelShort(r.model))}</span></td>
    <td class="num">${fmt.int(r.billable_tokens)}</td>
    <td class="num">${fmt.int(r.cache_read_tokens)}</td>
    <td><a href="${sessionHref(r.session_id, provider)}" class="mono" onclick="event.stopPropagation()">${fmt.htmlSafe(fmt.sessionShort(r.session_id))}</a></td>
  </tr>`;
}

function setSelectedPromptRow(body, index) {
  if (!body) return;
  body.querySelectorAll('tr.selected').forEach(row => row.classList.remove('selected'));
  body.querySelector(`tr[data-i="${index}"]`)?.classList.add('selected');
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
