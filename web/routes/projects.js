import {
  api,
  exportHref,
  fmt,
  providerTabs,
  readProvider,
  withQuery,
  writeHashParams,
} from '/web/app.js';

export default async function (root) {
  const provider = readProvider();
  const exportParams = {
    provider: provider.key === 'all' ? null : provider.key,
  };
  const rows = await api(withQuery('/api/projects', exportParams));
  const selectedProvider = provider.key === 'all' ? 'all providers' : fmt.providerLabel(provider.key);
  root.innerHTML = `
    <div class="card">
      <h2>Projects</h2>
      <div class="flex" style="margin:-8px 0 12px;align-items:flex-start">
        <p class="muted" style="margin:0">Sorted by billable token spend for ${fmt.htmlSafe(selectedProvider)}. Cache reads are billed cheaper, so high cache-read columns are usually good.</p>
        <span class="spacer"></span>
        <div class="export-actions">
          <a href="${exportHref('projects', 'csv', exportParams)}" class="button-link">Export CSV</a>
          <a href="${exportHref('projects', 'json', exportParams)}" class="button-link">Export JSON</a>
        </div>
      </div>
      <div class="flex" style="margin:-4px 0 16px;justify-content:flex-end">
        ${providerTabs(provider.key)}
      </div>
      <table>
        <thead><tr><th>project</th><th class="num">sessions</th><th class="num">turns</th><th class="num">billable tokens</th><th class="num">cache reads</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td title="${fmt.htmlSafe(r.project_slug)}">${fmt.htmlSafe(r.project_name || r.project_slug)}</td>
              <td class="num">${fmt.int(r.sessions)}</td>
              <td class="num">${fmt.int(r.turns)}</td>
              <td class="num">${fmt.int(r.billable_tokens)}</td>
              <td class="num">${fmt.int(r.cache_read_tokens)}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="muted">no projects for this provider yet</td></tr>'}
        </tbody>
      </table>
    </div>`;

  root.querySelectorAll('.provider-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      writeHashParams({ provider: btn.dataset.provider === 'all' ? null : btn.dataset.provider });
    });
  });
}
