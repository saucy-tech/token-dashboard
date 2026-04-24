import {
  api,
  currentHashPath,
  exportHref,
  fmt,
  providerTabs,
  readHashParam,
  readProvider,
  withQuery,
  writeHashParams,
} from '/web/app.js';
import { limitForProvider, loadUsageSettings, sessionLimitSummary } from '/web/limits.js';

const RANGES = [
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: 'All', days: null },
];
const PAGE_SIZE = 50;
let _page = 0;
let _rangeScopeKey = '';

function readRange() {
  const key = readHashParam('range');
  return RANGES.find(range => range.key === key) || RANGES[1];
}

function writeRange(key) {
  writeHashParams({ range: key });
}

function sinceIso(range) {
  if (!range.days) return null;
  return new Date(Date.now() - range.days * 86400 * 1000).toISOString();
}

function untilIso(range) {
  if (!range.days) return null;
  return new Date().toISOString();
}

export default async function (root) {
  const id = decodeURIComponent(currentHashPath().split('/')[2] || '');
  if (!id) return renderList(root);
  return renderSession(root, id);
}

async function renderList(root) {
  const provider = readProvider();
  const range = readRange();
  const since = sinceIso(range);
  const until = untilIso(range);
  const selectedProvider = provider.key === 'all' ? 'all providers' : fmt.providerLabel(provider.key);
  const scopeKey = `${provider.key}|${range.key}`;
  if (scopeKey !== _rangeScopeKey) {
    _rangeScopeKey = scopeKey;
    _page = 0;
  }
  const exportParams = {
    limit: 1000,
    since,
    until,
    provider: provider.key === 'all' ? null : provider.key,
  };
  const list = await api(withQuery('/api/sessions', {
    limit: PAGE_SIZE,
    offset: 0,
    since,
    until,
    provider: provider.key === 'all' ? null : provider.key,
  }));
  const hasMoreInitial = list.length === PAGE_SIZE;
  const rangeTabs = `
    <div class="range-tabs" role="tablist">
      ${RANGES.map(r => `<button data-range="${r.key}" class="${r.key === range.key ? 'active' : ''}">${r.label}</button>`).join('')}
    </div>`;
  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Sessions</h2>
      <span class="muted" style="font-size:12px">${range.days ? `last ${range.days} days` : 'all time'} · ${fmt.htmlSafe(selectedProvider)}</span>
      <div class="spacer"></div>
      ${rangeTabs}
    </div>
    <div class="card">
      <h2>Sessions</h2>
      <div class="flex" style="margin:-8px 0 12px;align-items:flex-start">
        <p class="muted" style="margin:0">Showing ${fmt.htmlSafe(selectedProvider)}.</p>
        <span class="spacer"></span>
        <div class="export-actions">
          <a href="${exportHref('sessions', 'csv', exportParams)}" class="button-link">Export CSV</a>
          <a href="${exportHref('sessions', 'json', exportParams)}" class="button-link">Export JSON</a>
        </div>
      </div>
      <div class="flex" style="margin:-4px 0 16px;justify-content:flex-end">
        ${providerTabs(provider.key)}
      </div>
      <table>
        <thead><tr><th>started</th><th>project</th><th>provider</th><th class="num">turns</th><th class="num">tokens</th><th>session</th></tr></thead>
        <tbody id="sessions-body">
          ${list.length ? list.map(s => sessionRow(s, provider)).join('') : '<tr id="sessions-empty"><td colspan="6" class="muted">no sessions for this provider and range yet</td></tr>'}
        </tbody>
      </table>
      <div style="margin-top:12px">
        <button class="ghost" id="sessions-load-more" ${hasMoreInitial ? '' : 'hidden'}>Load 50 more</button>
      </div>
    </div>`;

  root.querySelectorAll('.provider-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      writeHashParams({ provider: btn.dataset.provider === 'all' ? null : btn.dataset.provider });
    });
  });
  root.querySelectorAll('.range-tabs button').forEach(btn => {
    btn.addEventListener('click', () => writeRange(btn.dataset.range));
  });

  const body = root.querySelector('#sessions-body');
  const loadMore = root.querySelector('#sessions-load-more');
  if (!body || !loadMore) return;
  loadMore.addEventListener('click', async () => {
    _page += 1;
    const next = await api(withQuery('/api/sessions', {
      limit: PAGE_SIZE,
      offset: _page * PAGE_SIZE,
      since,
      until,
      provider: provider.key === 'all' ? null : provider.key,
    }));
    if (!next.length) {
      loadMore.hidden = true;
      return;
    }
    const empty = body.querySelector('#sessions-empty');
    if (empty) empty.remove();
    body.insertAdjacentHTML('beforeend', next.map(s => sessionRow(s, provider)).join(''));
    if (next.length < PAGE_SIZE) loadMore.hidden = true;
  });
}

function sessionRow(s, provider) {
  return `<tr>
    <td class="mono">${fmt.ts(s.started)}</td>
    <td title="${fmt.htmlSafe(s.project_slug)}">${fmt.htmlSafe(s.project_name || s.project_slug)}</td>
    <td><span class="badge ${fmt.providerClass(s.provider)}">${fmt.htmlSafe(fmt.providerLabel(s.provider))}</span></td>
    <td class="num">${fmt.int(s.turns)}</td>
    <td class="num">${fmt.int(s.tokens)}</td>
    <td><a href="${sessionHref(s.session_id, provider)}" class="mono">${fmt.htmlSafe(fmt.sessionShort(s.session_id))}</a></td>
  </tr>`;
}

async function renderSession(root, id) {
  const turns = await api('/api/sessions/' + encodeURIComponent(id));
  let totalIn = 0, totalOut = 0, totalCacheRd = 0;
  let totalCacheCreate = 0;
  for (const t of turns) {
    if (t.type !== 'assistant') continue;
    totalIn += t.input_tokens || 0;
    totalOut += t.output_tokens || 0;
    totalCacheRd += t.cache_read_tokens || 0;
    totalCacheCreate += (t.cache_create_5m_tokens || 0) + (t.cache_create_1h_tokens || 0);
  }
  const billable = totalIn + totalOut + totalCacheCreate;
  const slug = (turns[0] && turns[0].project_slug) || '';
  const cwd = (turns.find(t => t.cwd) || {}).cwd || '';
  const base = cwd ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() : '';
  const project = base || slug;
  const started = (turns[0] && turns[0].timestamp) || '';
  const ended = (turns[turns.length-1] && turns[turns.length-1].timestamp) || '';
  const provider = (turns[0] && turns[0].provider) || '';
  const settings = await loadUsageSettings(api);
  const limits = limitForProvider(settings, provider || 'all');
  const usage = sessionLimitSummary({ billable_tokens: billable }, limits);
  const usagePct = usage.status.pct == null ? null : usage.pct;
  const usageClass = usage.status.cls === 'exceeded' ? 'over' : (usage.status.cls === 'near' || usage.status.cls === 'caution' ? 'near' : (usage.status.cls === 'normal' ? 'ok' : ''));
  const sessionLabel = (turns[0] && turns[0].session_label) || '';
  const backProvider = readProvider();
  const backHref = backProvider.key === 'all'
    ? '#/sessions'
    : '#/sessions?provider=' + encodeURIComponent(backProvider.key);

  root.innerHTML = `
    <div class="card">
      <h2 style="display:flex;align-items:center">
        <span>${fmt.htmlSafe(sessionLabel || ('Session ' + fmt.sessionShort(id)))}</span>
        <span class="spacer"></span>
        ${provider ? `<span class="badge ${fmt.providerClass(provider)}">${fmt.htmlSafe(fmt.providerLabel(provider))}</span>` : ''}
        <a href="${backHref}" class="muted">← all sessions</a>
      </h2>
      <div class="flex muted" style="font-family:var(--mono);font-size:12px;flex-wrap:wrap;gap:14px">
        <span>${fmt.htmlSafe(project)}</span>
        <span>${fmt.ts(started)} → ${fmt.ts(ended)}</span>
        <span>${fmt.sessionShort(id)}</span>
        <span>${turns.length} records</span>
        <span>${fmt.int(totalIn)} in · ${fmt.int(totalOut)} out · ${fmt.int(totalCacheRd)} cache rd</span>
      </div>
      <div class="session-limit-strip ${usageClass}">
        <div>
          <strong>${fmt.compact(billable)}</strong>
          <span class="muted">billable tokens in this session</span>
        </div>
        <div class="session-limit-meter" aria-label="session limit usage">
          <span style="width:${usagePct == null ? 0 : usagePct}%"></span>
        </div>
        <div class="muted">
          ${limits.sessionTokens ? `${usagePct}% of ${fmt.compact(limits.sessionTokens)} session limit` : '<a href="#/settings">Set session limit</a>'}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Turn-by-turn</h3>
      <table>
        <thead><tr><th>time</th><th>type</th><th>model</th><th class="blur-sensitive">prompt / tools</th><th class="num">in</th><th class="num">out</th><th class="num">cache rd</th><th></th></tr></thead>
        <tbody>
          ${turns.map((t, i) => {
            const tools = toolCalls(t);
            const toolUses = tools.filter(x => x.tool_name !== '_tool_result');
            const summary = t.prompt_text ? fmt.short(t.prompt_text, 110)
              : toolUses.length ? toolUses.map(x => x.tool_name).join(' · ')
              : '';
            const hasDetail = Boolean(t.prompt_text || tools.length);
            return `<tr class="${hasDetail ? 'session-row-with-detail' : ''}" data-i="${i}">
              <td class="mono">${(t.timestamp || '').slice(11,19)}</td>
              <td>${t.type}${t.is_sidechain ? ' <span class="badge">side</span>' : ''}</td>
              <td>${t.model ? `<span class="badge ${fmt.modelClass(t.model)}">${fmt.htmlSafe(fmt.modelShort(t.model))}</span>` : ''}</td>
              <td class="blur-sensitive">${fmt.htmlSafe(summary)}</td>
              <td class="num">${fmt.int(t.input_tokens)}</td>
              <td class="num">${fmt.int(t.output_tokens)}</td>
              <td class="num">${fmt.int(t.cache_read_tokens)}</td>
              <td class="num">${hasDetail ? `<button class="ghost detail-toggle" data-i="${i}">Details</button>` : ''}</td>
            </tr>
            ${hasDetail ? detailRow(t, i, tools) : ''}`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  root.querySelectorAll('.detail-toggle').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      toggleDetail(root, btn.dataset.i);
    });
  });
  root.querySelectorAll('.session-row-with-detail').forEach(row => {
    row.addEventListener('click', () => toggleDetail(root, row.dataset.i));
  });
  root.querySelectorAll('.copy-prompt').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      copyText(btn, turns[Number(btn.dataset.i)]?.prompt_text || '');
    });
  });
}

function sessionHref(sessionId, provider) {
  return '#/sessions/' + encodeURIComponent(sessionId) + (
    provider.key === 'all' ? '' : '?provider=' + encodeURIComponent(provider.key)
  );
}

function toolCalls(turn) {
  if (Array.isArray(turn.tool_calls)) return turn.tool_calls;
  if (!turn.tool_calls_json) return [];
  try {
    return JSON.parse(turn.tool_calls_json).map(x => ({
      tool_name: x.name,
      target: x.target,
      result_tokens: null,
      is_error: 0,
      timestamp: turn.timestamp,
    }));
  } catch {
    return [];
  }
}

function detailRow(turn, index, tools) {
  return `
    <tr class="session-detail-row" data-detail="${index}" hidden>
      <td colspan="8">
        <div class="session-detail">
          ${turn.prompt_text ? `
            <div class="session-detail-head">
              <strong>Prompt text</strong>
              <button class="ghost copy-prompt" data-i="${index}">Copy prompt</button>
            </div>
            <pre class="blur-sensitive">${fmt.htmlSafe(turn.prompt_text)}</pre>
          ` : ''}
          ${tools.length ? `
            <div class="session-detail-head">
              <strong>Tool calls</strong>
              <span class="muted">${fmt.int(tools.length)} total</span>
            </div>
            <table class="tool-detail-table">
              <thead><tr><th>time</th><th>tool</th><th>target / id</th><th class="num">result tokens</th><th>status</th></tr></thead>
              <tbody>
                ${tools.map(tool => `
                  <tr>
                    <td class="mono">${(tool.timestamp || '').slice(11,19)}</td>
                    <td><span class="badge">${fmt.htmlSafe(tool.tool_name || 'tool')}</span></td>
                    <td class="blur-sensitive">${fmt.htmlSafe(tool.target || '')}</td>
                    <td class="num">${tool.result_tokens == null ? '—' : fmt.int(tool.result_tokens)}</td>
                    <td>${tool.is_error ? '<span class="badge tool-error">error</span>' : '<span class="badge tool-ok">ok</span>'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          ` : ''}
        </div>
      </td>
    </tr>`;
}

function toggleDetail(root, index) {
  const row = root.querySelector(`.session-detail-row[data-detail="${index}"]`);
  const btn = root.querySelector(`.detail-toggle[data-i="${index}"]`);
  if (!row) return;
  row.hidden = !row.hidden;
  if (btn) btn.textContent = row.hidden ? 'Details' : 'Hide';
}

async function copyText(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
    const label = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => {
      btn.textContent = label;
    }, 1200);
  } catch {
    btn.textContent = 'Copy failed';
  }
}
