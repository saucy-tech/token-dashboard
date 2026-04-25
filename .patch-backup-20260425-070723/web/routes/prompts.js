// web/routes/prompts.js — PATCHED: added filter chips (provider, model, cache-hit%)
import {
  api,
  exportHref,
  fmt,
  providerBadge,
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
function writeSort(key) { writeHashParams({ sort: key }); }
function writeProvider(key) { writeHashParams({ provider: key === 'all' ? null : key }); }
function sessionHref(sessionId, provider) {
  return '#/sessions/' + encodeURIComponent(sessionId) + (
    provider.key === 'all' ? '' : '?provider=' + encodeURIComponent(provider.key)
  );
}

// ── client-side filter state (not URL-backed — fast, no reload) ───────────────
let _modelFilter  = 'all';
let _cacheFilter  = 'all'; // 'all' | 'cached' | 'uncached'

export default async function (root) {
  const sort     = readSort();
  const provider = readProvider();
  const scopeKey = `${sort.key}|${provider.key}`;
  if (scopeKey !== _promptScopeKey) { _promptScopeKey = scopeKey; _page = 0; }

  const rows = await api(withQuery('/api/prompts', {
    limit: PAGE_SIZE, offset: 0, sort: sort.key,
    provider: provider.key === 'all' ? null : provider.key,
  }));

  // collect unique models for the chip list
  const allModels = [...new Set(rows.map(r => r.model).filter(Boolean))];

  const sortTabs = `
    <div class="range-tabs" role="tablist">
      ${SORTS.map(s => `<button data-sort="${s.key}" class="${s.key === sort.key ? 'active' : ''}">${s.label}</button>`).join('')}
    </div>`;

  const subtitle = sort.key === 'recent'
    ? 'Your latest prompts and the assistant turn each one triggered. Click a row to see the full prompt.'
    : 'The prompts that used the most billable tokens. Cache-read cost is shown only when the model has pricing.';
  const selectedProvider = provider.key === 'all' ? 'all providers' : fmt.providerLabel(provider.key);
  const exportParams = { limit: 1000, sort: sort.key, provider: provider.key === 'all' ? null : provider.key };

  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Prompts</h2>
      <div class="spacer"></div>
      ${sortTabs}
    </div>

    <div class="flex" style="margin:-4px 0 10px;justify-content:flex-end">
      ${providerTabs(provider.key)}
    </div>

    <!-- PATCHED: filter chips -->
    <div class="filter-chips-bar" id="filter-chips-bar">
      <span class="filter-chips-label">Filter</span>
      <div class="filter-chip-group" id="model-chips">
        <button class="filter-chip active" data-model="all">All models</button>
        ${allModels.map(m => `<button class="filter-chip" data-model="${fmt.htmlSafe(m)}">${fmt.htmlSafe(fmt.modelShort(m))}</button>`).join('')}
      </div>
      <span class="filter-chip-divider"></span>
      <div class="filter-chip-group" id="cache-chips">
        <button class="filter-chip active" data-cache="all">Any cache</button>
        <button class="filter-chip" data-cache="cached">Cache hit</button>
        <button class="filter-chip" data-cache="uncached">No cache</button>
      </div>
      <span class="filter-count" id="filter-count">${rows.length} prompts</span>
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
          <th class="num">cache%</th>
          <th>session</th>
        </tr></thead>
        <tbody id="prompts-body">
          ${rows.length ? rows.map((r, i) => promptRow(r, i, sort, provider)).join('') : '<tr id="prompts-empty"><td colspan="9" class="muted">no prompts yet</td></tr>'}
        </tbody>
      </table>
      <div style="margin-top:12px">
        <button class="ghost" id="prompts-load-more" ${rows.length === PAGE_SIZE ? '' : 'hidden'}>Load 50 more</button>
      </div>
    </div>
    <div id="drawer"></div>
  `;

  // ── sort + provider tab wiring ────────────────────────────────────────────
  root.querySelectorAll('.range-tabs button').forEach(btn => {
    if (btn.dataset.sort)     btn.addEventListener('click', () => writeSort(btn.dataset.sort));
    if (btn.dataset.provider) btn.addEventListener('click', () => writeProvider(btn.dataset.provider));
  });

  // ── filter chips — client-side, no reload ────────────────────────────────
  function applyFilters() {
    let visible = 0;
    root.querySelectorAll('#prompts-body tr[data-i]').forEach(tr => {
      const idx = Number(tr.dataset.i);
      const r   = rows[idx];
      if (!r) return;
      const modelOk = _modelFilter === 'all' || r.model === _modelFilter;
      const cachePct = r.billable_tokens > 0
        ? Math.round((r.cache_read_tokens / (r.billable_tokens + r.cache_read_tokens)) * 100)
        : 0;
      const cacheOk = _cacheFilter === 'all'
        || (_cacheFilter === 'cached'   && cachePct > 0)
        || (_cacheFilter === 'uncached' && cachePct === 0);
      const show = modelOk && cacheOk;
      tr.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    const fc = root.querySelector('#filter-count');
    if (fc) fc.textContent = `${visible} prompt${visible === 1 ? '' : 's'}`;
  }

  root.querySelector('#model-chips')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-model]');
    if (!btn) return;
    _modelFilter = btn.dataset.model;
    root.querySelectorAll('#model-chips .filter-chip').forEach(b => b.classList.toggle('active', b === btn));
    applyFilters();
  });

  root.querySelector('#cache-chips')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-cache]');
    if (!btn) return;
    _cacheFilter = btn.dataset.cache;
    root.querySelectorAll('#cache-chips .filter-chip').forEach(b => b.classList.toggle('active', b === btn));
    applyFilters();
  });

  // Restore filter state from previous visit
  if (_modelFilter !== 'all') {
    root.querySelectorAll('#model-chips .filter-chip').forEach(b =>
      b.classList.toggle('active', b.dataset.model === _modelFilter));
  }
  if (_cacheFilter !== 'all') {
    root.querySelectorAll('#cache-chips .filter-chip').forEach(b =>
      b.classList.toggle('active', b.dataset.cache === _cacheFilter));
    applyFilters();
  }

  // ── drawer ────────────────────────────────────────────────────────────────
  function openPrompt(index) {
    const r = rows[Number(index)];
    if (!r) return;
    const cachePct = r.billable_tokens > 0
      ? Math.round((r.cache_read_tokens / (r.billable_tokens + r.cache_read_tokens)) * 100) : 0;
    const drawer = document.getElementById('drawer');
    drawer.innerHTML = `
      <div class="card provider-surface ${fmt.providerClass(r.provider)}" style="margin-top:14px;">
        <h3 style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <span>Prompt detail</span>
          <span class="spacer"></span>
          ${providerBadge(r.provider)}
          <span class="badge ${fmt.modelClass(r.model)}">${fmt.htmlSafe(fmt.modelShort(r.model))}</span>
          <button id="drawer-close" class="ghost" style="padding:2px 8px;font-size:16px;line-height:1;">×</button>
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
        <!-- PATCHED: cost breakdown grid -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px;">
          ${[
            ['Billable', fmt.int(r.billable_tokens) + ' tok'],
            ['Cache rd', fmt.int(r.cache_read_tokens) + ' tok'],
            ['Cache hit', cachePct + '%'],
            ['Est. cost', promptCostDetail(r)],
          ].map(([l,v]) => `
            <div style="padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--muted);">${l}</div>
              <div style="font-family:var(--mono);font-size:14px;margin-top:3px;">${v}</div>
            </div>`).join('')}
        </div>
        <div class="flex" style="margin-top:12px;flex-wrap:wrap;gap:14px;">
          <span class="muted">${fmt.ts(r.timestamp)}</span>
          <span class="spacer"></span>
          <a href="${sessionHref(r.session_id, provider)}">Open session →</a>
        </div>
      </div>`;
    root.querySelector('#drawer-close')?.addEventListener('click', () => {
      drawer.innerHTML = '';
      setSelectedPromptRow(root.querySelector('#prompts-body'), null);
    });
  }

  const promptBody = root.querySelector('#prompts-body');
  promptBody?.addEventListener('click', e => {
    const row = e.target.closest('tr[data-i]');
    if (!row) return;
    openPrompt(row.dataset.i);
    setSelectedPromptRow(promptBody, row.dataset.i);
  });

  root.querySelector('#prompts-load-more')?.addEventListener('click', async function() {
    _page += 1;
    const next = await api(withQuery('/api/prompts', {
      limit: PAGE_SIZE, offset: _page * PAGE_SIZE, sort: sort.key,
      provider: provider.key === 'all' ? null : provider.key,
    }));
    if (!next.length) { this.hidden = true; return; }
    const empty = promptBody?.querySelector('#prompts-empty');
    if (empty) empty.remove();
    const startIndex = rows.length;
    rows.push(...next);
    promptBody?.insertAdjacentHTML('beforeend', next.map((r, idx) => promptRow(r, startIndex + idx, sort, provider)).join(''));
    if (next.length < PAGE_SIZE) this.hidden = true;
    applyFilters(); // re-apply active filters to new rows
  });

  const selectedPrompt = readHashParam('prompt');
  if (selectedPrompt) {
    const index = rows.findIndex(r => r.user_uuid === selectedPrompt);
    if (index >= 0) { openPrompt(index); setSelectedPromptRow(promptBody, String(index)); }
  }
}

function promptRow(r, index, sort, provider) {
  const cachePct = r.billable_tokens > 0
    ? Math.round((r.cache_read_tokens / (r.billable_tokens + r.cache_read_tokens)) * 100) : 0;
  return `<tr class="provider-row ${fmt.providerClass(r.provider)}" data-i="${index}" data-prompt="${fmt.htmlSafe(r.user_uuid)}" style="cursor:pointer">
    <td class="${sort.key === 'recent' ? 'mono' : 'num mono'}">${sort.key === 'recent' ? fmt.ts(r.timestamp) : promptCost(r)}</td>
    <td class="blur-sensitive">${fmt.htmlSafe(fmt.short(r.prompt_text, 110))}</td>
    <td>${fmt.htmlSafe(fmt.short(r.why_expensive || '', 90))}</td>
    <td>${providerBadge(r.provider)}</td>
    <td><span class="badge ${fmt.modelClass(r.model)}">${fmt.htmlSafe(fmt.modelShort(r.model))}</span></td>
    <td class="num">${fmt.int(r.billable_tokens)}</td>
    <td class="num">${fmt.int(r.cache_read_tokens)}</td>
    <td class="num" style="color:${cachePct>50?'var(--good)':cachePct>0?'var(--warn)':'var(--muted-2)'}">${cachePct}%</td>
    <td><a href="${sessionHref(r.session_id, provider)}" class="mono" onclick="event.stopPropagation()">${fmt.htmlSafe(fmt.sessionShort(r.session_id))}</a></td>
  </tr>`;
}

function setSelectedPromptRow(body, index) {
  if (!body) return;
  body.querySelectorAll('tr.selected').forEach(row => row.classList.remove('selected'));
  if (index != null) body.querySelector(`tr[data-i="${index}"]`)?.classList.add('selected');
}

function promptCost(r) {
  if (r.estimated_cost_usd == null) return '<span class="muted">not priced</span>';
  return `${r.estimated_cost_estimated ? '~' : ''}${fmt.usd4(r.estimated_cost_usd)}`;
}

function promptCostDetail(r) {
  if (r.estimated_cost_usd == null) return 'not priced';
  const prefix = r.estimated_cost_estimated ? '~' : '';
  return `${prefix}${fmt.usd4(r.estimated_cost_usd)}`;
}
