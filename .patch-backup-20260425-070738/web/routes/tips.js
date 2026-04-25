// web/routes/tips.js — PATCHED: card grid layout (CodexBar-style: severity dot + savings + "Show me")
import { api, fmt, providerBadge, providerTabs, readProvider, withQuery, writeHashParams } from '/web/app.js';

const SEV_COLOR  = { high: 'var(--bad)', medium: 'var(--warn)', info: 'var(--accent)' };
const SEV_LABEL  = { high: 'High',       medium: 'Medium',      info: 'Info' };
const CAT_COLOR  = {
  cache:   'rgba(74,158,255,0.12)',
  model:   'rgba(124,92,255,0.12)',
  session: 'rgba(232,162,59,0.12)',
  tool:    'rgba(63,182,139,0.12)',
  weekly:  'rgba(229,72,77,0.12)',
};

function tipSeverity(t) {
  // Map tip signal/category to high/medium/info
  const sig = (t.signal || '').toLowerCase();
  const cat = (t.category || '').toLowerCase();
  if (sig.includes('high') || cat.includes('cache') && t.savings_usd > 10) return 'high';
  if (sig.includes('medium') || t.savings_usd > 3) return 'medium';
  return 'info';
}

function savingsLabel(t) {
  if (t.savings_usd != null && t.savings_usd > 0) return `$${Number(t.savings_usd).toFixed(2)}/week`;
  if (t.savings_tokens != null && t.savings_tokens > 0) return `${fmt.compact(t.savings_tokens)} tokens`;
  return null;
}

function showMeHref(t) {
  // "Show me" navigates to filtered prompts view
  const params = new URLSearchParams();
  if (t.provider) params.set('provider', t.provider);
  if (t.filter_model) params.set('model', t.filter_model);
  return '#/prompts' + (params.toString() ? '?' + params.toString() : '');
}

function tipCard(t, isHighlighted) {
  const sev      = tipSeverity(t);
  const sevColor = SEV_COLOR[sev];
  const savings  = savingsLabel(t);
  const catBg    = CAT_COLOR[(t.category || '').toLowerCase()] || 'transparent';
  const links    = Array.isArray(t.links) ? t.links : [];

  return `
    <div class="tip-card" data-tip-key="${fmt.htmlSafe(t.key)}"
      style="border-color:color-mix(in srgb,${sevColor} 28%,var(--border));">
      <!-- severity band -->
      <div style="height:3px;background:${sevColor};opacity:.7;margin:-16px -16px 14px;border-radius:9px 9px 0 0;"></div>

      <!-- header: category + provider + severity badge -->
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
        <span class="badge" style="background:${catBg};">${fmt.htmlSafe(t.category || 'General')}</span>
        ${t.provider ? providerBadge(t.provider) : ''}
        ${t.signal ? `<span class="badge subtle">${fmt.htmlSafe(t.signal)}</span>` : ''}
        <span style="margin-left:auto;padding:2px 8px;border-radius:4px;font-size:10px;font-family:var(--mono);font-weight:600;
          color:${sevColor};border:1px solid color-mix(in srgb,${sevColor} 35%,transparent);
          background:color-mix(in srgb,${sevColor} 10%,transparent);">${SEV_LABEL[sev]}</span>
      </div>

      <!-- title: one bold sentence -->
      <div style="font-weight:600;font-size:13px;line-height:1.4;margin-bottom:8px;">${fmt.htmlSafe(t.title)}</div>

      <!-- body -->
      <div class="tip-body" style="margin-bottom:12px;">${fmt.htmlSafe(t.body)}</div>

      ${t.why ? `
        <div class="tip-why" style="margin-bottom:10px;">
          <span>Why</span>${fmt.htmlSafe(t.why)}
        </div>` : ''}

      ${t.rule ? `
        <div class="tip-rule" style="margin-bottom:10px;">
          <span>Rule</span>${fmt.htmlSafe(t.rule)}
        </div>` : ''}

      <!-- footer: savings number + actions -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px solid var(--border);margin-top:auto;">
        <div>
          ${savings ? `
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;font-weight:600;color:var(--muted);">Potential savings</div>
            <div style="font-family:var(--mono);font-size:16px;font-weight:600;color:${sevColor};margin-top:2px;">${fmt.htmlSafe(savings)}</div>
          ` : '<div style="color:var(--muted-2);font-size:11px;">FYI</div>'}
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          ${links.map(link => `
            <a href="${fmt.htmlSafe(link.href)}" class="button-link ${link.type === 'prompt' ? 'blur-sensitive' : ''}"
              style="font-size:12px;padding:5px 10px;">${fmt.htmlSafe(link.label)}</a>`).join('')}
          <a href="${fmt.htmlSafe(showMeHref(t))}" class="button-link" style="font-size:12px;padding:5px 10px;">Show me</a>
          <button class="ghost tip-dismiss" data-key="${fmt.htmlSafe(t.key)}"
            style="font-size:12px;padding:5px 10px;color:var(--muted-2);">Dismiss</button>
        </div>
      </div>
    </div>`;
}

export default async function (root) {
  const provider = readProvider();
  const tips = await api(withQuery('/api/tips', {
    provider: provider.key === 'all' ? null : provider.key,
  }));

  // Sort: high severity first
  const sorted = [...tips].sort((a, b) => {
    const order = { high: 0, medium: 1, info: 2 };
    return (order[tipSeverity(a)] ?? 3) - (order[tipSeverity(b)] ?? 3);
  });

  const highCount   = sorted.filter(t => tipSeverity(t) === 'high').length;
  const medCount    = sorted.filter(t => tipSeverity(t) === 'medium').length;
  const totalSavings = sorted.reduce((s, t) => s + (t.savings_usd || 0), 0);

  root.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
      <h2 style="margin:0;font-size:16px;letter-spacing:-.01em;">Suggestions</h2>
      <span style="color:var(--muted);font-size:12px;">Rule-based pattern detection · last 7 days</span>
      <div style="margin-left:auto;">
        ${providerTabs(provider.key)}
      </div>
    </div>

    ${sorted.length === 0 ? `
      <div class="card" style="padding:48px;text-align:center;color:var(--muted);">
        <div style="font-size:32px;opacity:.2;margin-bottom:12px;">✓</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:6px;">No active suggestions</div>
        <div style="font-size:12px;">Token Dashboard surfaces patterns weekly — check back after more activity.</div>
      </div>` : `

    <!-- summary strip -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px;">
      ${[
        ['Tips', sorted.length, ''],
        ['High priority', highCount, 'color:var(--bad)'],
        ['Medium', medCount, 'color:var(--warn)'],
        ['Potential savings', totalSavings > 0 ? '$' + totalSavings.toFixed(2) + '/wk' : '—', 'color:var(--good)'],
      ].map(([l, v, style]) => `
        <div class="card kpi">
          <div class="label">${l}</div>
          <div class="value" style="${style}">${v}</div>
        </div>`).join('')}
    </div>

    <!-- card grid -->
    <div class="tip-card-grid" id="tips-list">
      ${sorted.map(t => tipCard(t)).join('')}
    </div>`}
  `;

  // Provider tabs
  root.querySelectorAll('.provider-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      writeHashParams({ provider: btn.dataset.provider === 'all' ? null : btn.dataset.provider });
    });
  });

  // Dismiss buttons
  root.querySelectorAll('.tip-dismiss').forEach(b => {
    b.addEventListener('click', async () => {
      await fetch('/api/tips/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: b.dataset.key }),
      });
      const card = root.querySelector(`[data-tip-key="${CSS.escape(b.dataset.key || '')}"]`);
      card?.remove();
      const list = root.querySelector('#tips-list');
      if (list && !list.querySelector('[data-tip-key]')) {
        list.innerHTML = `
          <div class="card" style="padding:40px;text-align:center;color:var(--muted);">
            <div style="font-size:28px;opacity:.2;margin-bottom:10px;">✓</div>
            <div style="font-weight:600;color:var(--text);">All caught up</div>
          </div>`;
      }
    });
  });
}
