import { api, dataSourcePanel, optionalApi, state, $ } from '/web/app.js';

export default async function (root) {
  const cur = await api('/api/plan');
  const sources = await optionalApi('/api/sources', { sources: [] });
  const plans = Object.entries(cur.pricing.plans);
  root.innerHTML = `
    <div style="margin-bottom:16px">
      ${dataSourcePanel(sources, { scanButton: true })}
    </div>

    <div class="card">
      <h2>Settings</h2>
      <h3 style="margin-top:16px">Plan</h3>
      <p class="muted" style="margin:0 0 12px">Sets the subscription context shown beside API-equivalent token estimates. The dashboard does not convert Pro or Max usage into a true monthly bill.</p>
      <div class="flex">
        <select id="plan">
          ${plans.map(([k,v]) => `<option value="${k}" ${k===cur.plan?'selected':''}>${v.label}${v.monthly?` — $${v.monthly}/mo`:''}</option>`).join('')}
        </select>
        <button class="primary" id="save">Save</button>
        <span id="msg" class="muted"></span>
      </div>

      <hr class="divider">

      <h3>Pricing table</h3>
      <p class="muted" style="margin:0 0 12px">Rates are used for API-equivalent estimates only. Edit <code>pricing.json</code> in the project root to change rates, then reload.</p>
      <table>
        <thead><tr><th>model</th><th class="num">input</th><th class="num">output</th><th class="num">cache read</th><th class="num">cache 5m</th><th class="num">cache 1h</th></tr></thead>
        <tbody>
          ${Object.entries(cur.pricing.models).map(([k,v]) => `
            <tr><td><span class="badge ${v.tier}">${k}</span></td>
              <td class="num">$${v.input.toFixed(2)}</td>
              <td class="num">$${v.output.toFixed(2)}</td>
              <td class="num">$${v.cache_read.toFixed(2)}</td>
              <td class="num">$${v.cache_create_5m.toFixed(2)}</td>
              <td class="num">$${v.cache_create_1h.toFixed(2)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="muted" style="margin-top:8px;font-size:11px">Rates per 1M tokens, USD.</p>

      <hr class="divider">

      <h3>Known limitations</h3>
      <ul class="muted limitation-list">
        <li>Costs are token-rate estimates. Subscription plans are flat monthly prices and are not allocated per turn.</li>
        <li>Unknown model IDs are omitted from cost totals unless their name matches a known Claude tier fallback.</li>
        <li>Totals include only supported local Claude Code and Codex logs that have been scanned into the SQLite cache.</li>
        <li>Warp and server-side Cowork sessions are not included because they do not have a confirmed local usage source here.</li>
        <li>Skill token counts are partial; the Skills tab can count invocations more reliably than loaded skill text.</li>
      </ul>

      <hr class="divider">

      <h3>Privacy</h3>
      <p class="muted">Press <code>Cmd/Ctrl + B</code> anywhere to blur prompt text and other sensitive content for screenshots.</p>
    </div>`;

  root.querySelector('[data-scan-now]')?.addEventListener('click', async event => {
    event.currentTarget.textContent = 'Scanning...';
    await api('/api/scan');
    window.dispatchEvent(new Event('hashchange'));
  });

  $('#save').addEventListener('click', async () => {
    const plan = $('#plan').value;
    await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
    state.plan = plan;
    document.getElementById('plan-pill').textContent = plan;
    $('#msg').textContent = 'Saved.';
    $('#msg').style.color = 'var(--good)';
  });
}
