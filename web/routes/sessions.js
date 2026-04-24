import { api, fmt, readQuery } from '/web/app.js';

function apiWithSource(path) {
  const s = readQuery('source', '').trim().toLowerCase();
  if (s !== 'claude' && s !== 'codex') return path;
  return path + (path.includes('?') ? '&' : '?') + 'source=' + encodeURIComponent(s);
}

function hashWithSource(baseHash) {
  const s = readQuery('source', '').trim().toLowerCase();
  if (s !== 'claude' && s !== 'codex') return baseHash;
  return baseHash + (baseHash.includes('?') ? '&' : '?') + 'source=' + encodeURIComponent(s);
}

export default async function (root) {
  const pathPart = (location.hash.replace(/^#/, '').split('?')[0] || '');
  const id = decodeURIComponent(pathPart.split('/')[2] || '');
  if (!id) return renderList(root);
  return renderSession(root, id);
}

async function renderList(root) {
  const list = await api(apiWithSource('/api/sessions?limit=100'));
  root.innerHTML = `
    <div class="card">
      <h2>Sessions</h2>
      <table>
        <thead><tr><th>started</th><th>project</th><th class="num">turns</th><th class="num">tokens</th><th>session</th></tr></thead>
        <tbody>
          ${list.map(s => `
            <tr>
              <td class="mono">${fmt.ts(s.started)}</td>
              <td title="${fmt.htmlSafe(s.project_slug)}">${fmt.htmlSafe(s.project_name || s.project_slug)}</td>
              <td class="num">${fmt.int(s.turns)}</td>
              <td class="num">${fmt.int(s.tokens)}</td>
              <td><a href="${hashWithSource('#/sessions/' + encodeURIComponent(s.session_id))}" class="mono">${fmt.htmlSafe(s.session_id.slice(0,8))}…</a></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function renderSession(root, id) {
  const turns = await api(apiWithSource('/api/sessions/' + encodeURIComponent(id)));
  if (!turns.length) {
    root.innerHTML = `
      <div class="card">
        <p class="muted">No rows for this session id (wrong id or source filter excludes it).</p>
        <p><a href="${hashWithSource('#/sessions')}">← all sessions</a></p>
      </div>`;
    return;
  }
  let totalIn = 0, totalOut = 0, totalCacheRd = 0;
  let modelCounts = {};
  for (const t of turns) {
    if (t.type !== 'assistant') continue;
    totalIn += t.input_tokens || 0;
    totalOut += t.output_tokens || 0;
    totalCacheRd += t.cache_read_tokens || 0;
    const m = t.model || 'unknown';
    modelCounts[m] = (modelCounts[m] || 0) + 1;
  }
  const slug = (turns[0] && turns[0].project_slug) || '';
  const cwd = (turns.find(t => t.cwd) || {}).cwd || '';
  const base = cwd ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() : '';
  const project = base || slug;
  const started = (turns[0] && turns[0].timestamp) || '';
  const ended = (turns[turns.length-1] && turns[turns.length-1].timestamp) || '';

  root.innerHTML = `
    <div class="card">
      <h2 style="display:flex;align-items:center">
        <span>Session ${fmt.htmlSafe(id.slice(0,8))}…</span>
        <span class="spacer"></span>
        <a href="${hashWithSource('#/sessions')}" class="muted">← all sessions</a>
      </h2>
      <div class="flex muted" style="font-family:var(--mono);font-size:12px;flex-wrap:wrap;gap:14px">
        <span>${fmt.htmlSafe(project)}</span>
        <span>${fmt.ts(started)} → ${fmt.ts(ended)}</span>
        <span>${turns.length} records</span>
        <span>${fmt.int(totalIn)} in · ${fmt.int(totalOut)} out · ${fmt.int(totalCacheRd)} cache rd</span>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Turn-by-turn</h3>
      <table>
        <thead><tr><th>time</th><th>type</th><th>model</th><th class="blur-sensitive">prompt / tools</th><th class="num">in</th><th class="num">out</th><th class="num">cache rd</th></tr></thead>
        <tbody>
          ${turns.map(t => {
            const tools = t.tool_calls_json ? JSON.parse(t.tool_calls_json) : [];
            const summary = t.prompt_text ? fmt.short(t.prompt_text, 110)
              : tools.length ? tools.map(x => x.name).join(' · ')
              : '';
            return `<tr>
              <td class="mono">${(t.timestamp || '').slice(11,19)}</td>
              <td>${t.type}${t.is_sidechain ? ' <span class="badge">side</span>' : ''}</td>
              <td>${t.model ? `<span class="badge ${fmt.modelClass(t.model)}">${fmt.htmlSafe(fmt.modelShort(t.model))}</span>` : ''}</td>
              <td class="blur-sensitive">${fmt.htmlSafe(summary)}</td>
              <td class="num">${fmt.int(t.input_tokens)}</td>
              <td class="num">${fmt.int(t.output_tokens)}</td>
              <td class="num">${fmt.int(t.cache_read_tokens)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}
