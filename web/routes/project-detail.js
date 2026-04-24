import { api, currentHashPath, fmt } from '/web/app.js';

function sessionHref(sessionId) {
  return '#/sessions/' + encodeURIComponent(sessionId);
}

function promptCost(r) {
  if (r.estimated_cost_usd == null) return '<span class="muted">not priced</span>';
  return `${r.estimated_cost_estimated ? '~' : ''}${fmt.usd4(r.estimated_cost_usd)}`;
}

export default async function (root) {
  const slug = decodeURIComponent(currentHashPath().split('/')[2] || '');
  if (!slug) {
    root.innerHTML = '<div class="card"><h2>Project not found</h2><a href="#/projects">← Back to Projects</a></div>';
    return;
  }

  const encoded = encodeURIComponent(slug);
  const [sessions, prompts] = await Promise.all([
    api(`/api/projects/${encoded}/sessions?limit=50`),
    api(`/api/projects/${encoded}/prompts?limit=10`),
  ]);

  const projectName = (sessions.find(s => s.project_name) || {}).project_name || slug;

  root.innerHTML = `
    <div class="card">
      <h2 style="display:flex;align-items:center">
        <span>${fmt.htmlSafe(projectName)}</span>
        <span class="spacer"></span>
        <a href="#/projects" class="muted">← Back to Projects</a>
      </h2>
      <p class="muted" title="${fmt.htmlSafe(slug)}">${fmt.htmlSafe(slug)}</p>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Sessions</h3>
      <table>
        <thead><tr><th>started</th><th>provider</th><th class="num">turns</th><th class="num">tokens</th><th>session</th></tr></thead>
        <tbody>
          ${sessions.map(s => `
            <tr>
              <td class="mono">${fmt.ts(s.started)}</td>
              <td><span class="badge ${fmt.providerClass(s.provider)}">${fmt.htmlSafe(fmt.providerLabel(s.provider))}</span></td>
              <td class="num">${fmt.int(s.turns)}</td>
              <td class="num">${fmt.int(s.tokens)}</td>
              <td><a href="${sessionHref(s.session_id)}" class="mono">${fmt.htmlSafe(fmt.sessionShort(s.session_id))}</a></td>
            </tr>`).join('') || '<tr><td colspan="5" class="muted">no sessions for this project</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Top prompts</h3>
      <p class="muted">Top 10 prompts for this project by billable tokens.</p>
      <table>
        <thead><tr>
          <th>cache-read cost</th>
          <th>prompt</th>
          <th>why</th>
          <th>provider</th>
          <th>model</th>
          <th class="num">tokens</th>
          <th class="num">cache rd</th>
          <th>session</th>
        </tr></thead>
        <tbody>
          ${prompts.map(r => `
            <tr>
              <td class="num mono">${promptCost(r)}</td>
              <td class="blur-sensitive">${fmt.htmlSafe(fmt.short(r.prompt_text, 110))}</td>
              <td>${fmt.htmlSafe(fmt.short(r.why_expensive || '', 90))}</td>
              <td><span class="badge ${fmt.providerClass(r.provider)}">${fmt.htmlSafe(fmt.providerLabel(r.provider))}</span></td>
              <td><span class="badge ${fmt.modelClass(r.model)}">${fmt.htmlSafe(fmt.modelShort(r.model))}</span></td>
              <td class="num">${fmt.int(r.billable_tokens)}</td>
              <td class="num">${fmt.int(r.cache_read_tokens)}</td>
              <td><a href="${sessionHref(r.session_id)}" class="mono">${fmt.htmlSafe(fmt.sessionShort(r.session_id))}</a></td>
            </tr>`).join('') || '<tr><td colspan="8" class="muted">no prompts for this project yet</td></tr>'}
        </tbody>
      </table>
    </div>`;
}
