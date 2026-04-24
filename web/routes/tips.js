import { api, fmt, providerBadge } from '/web/app.js';

export default async function (root) {
  const tips = await api('/api/tips');
  root.innerHTML = `
    <div class="card">
      <h2>Suggestions</h2>
      ${tips.length === 0
        ? '<p class="muted">No suggestions right now. Token Dashboard surfaces patterns weekly — check back after more activity.</p>'
        : `<p class="muted" style="margin:-8px 0 14px">Rule-based pattern detection over the last 7 days. Dismissed tips re-appear after 14 days.</p>`}
      ${tips.map(t => `
        <div class="tip">
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
    </div>`;
  root.querySelectorAll('button[data-key]').forEach(b => {
    b.addEventListener('click', async () => {
      await fetch('/api/tips/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: b.dataset.key }),
      });
      location.reload();
    });
  });
}
