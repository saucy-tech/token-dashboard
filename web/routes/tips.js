import { api, fmt, providerBadge, providerTabs, readProvider, withQuery, writeHashParams } from '/web/app.js';

export default async function (root) {
  const provider = readProvider();
  const tips = await api(withQuery('/api/tips', {
    provider: provider.key === 'all' ? null : provider.key,
  }));
  root.innerHTML = `
    <div class="card">
      <h2>Suggestions</h2>
      <div class="flex" style="margin:-8px 0 16px;justify-content:flex-end">
        ${providerTabs(provider.key)}
      </div>
      ${tips.length === 0
        ? '<p class="muted">No suggestions right now. Token Dashboard surfaces patterns weekly — check back after more activity.</p>'
        : `<p class="muted" style="margin:-8px 0 14px">Rule-based pattern detection over the last 7 days. Dismissed tips re-appear after 14 days.</p>`}
      <div id="tips-list">
      ${tips.map(t => `
        <div class="tip" data-tip-key="${fmt.htmlSafe(t.key)}">
          <div class="tip-head">
            <span class="badge">${fmt.htmlSafe(t.category)}</span>
            ${t.provider ? providerBadge(t.provider) : ''}
            ${t.signal ? `<span class="badge subtle">${fmt.htmlSafe(t.signal)}</span>` : ''}
            <strong>${fmt.htmlSafe(t.title)}</strong>
            <span class="spacer"></span>
            <button class="ghost" data-key="${fmt.htmlSafe(t.key)}">dismiss</button>
          </div>
          <p class="tip-body">${fmt.htmlSafe(t.body)}</p>
          ${t.why ? `<div class="tip-why"><span>Why</span>${fmt.htmlSafe(t.why)}</div>` : ''}
          ${t.rule ? `<div class="tip-rule"><span>Rule</span>${fmt.htmlSafe(t.rule)}</div>` : ''}
          ${Array.isArray(t.links) && t.links.length ? `
            <div class="tip-links">
              ${t.links.map(link => `<a href="${fmt.htmlSafe(link.href)}" class="button-link ${link.type === 'prompt' ? 'blur-sensitive' : ''}">${fmt.htmlSafe(link.label)}</a>`).join('')}
            </div>` : ''}
        </div>`).join('')}
      </div>
    </div>`;
  root.querySelectorAll('.provider-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      writeHashParams({ provider: btn.dataset.provider === 'all' ? null : btn.dataset.provider });
    });
  });
  root.querySelectorAll('button[data-key]').forEach(b => {
    b.addEventListener('click', async () => {
      await fetch('/api/tips/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: b.dataset.key }),
      });
      root.querySelector(`[data-tip-key="${CSS.escape(b.dataset.key || '')}"]`)?.remove();
      const list = root.querySelector('#tips-list');
      if (list && list.querySelectorAll('[data-tip-key]').length === 0) {
        list.innerHTML = '<p class="muted">No active tips.</p>';
      }
    });
  });
}
