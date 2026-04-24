import { api, dataSourcePanel, optionalApi, state, $ } from '/web/app.js';
import { loadUsageSettings, normalizeUsageSettings } from '/web/limits.js';

export default async function (root) {
  const cur = await api('/api/plan');
  const sources = await optionalApi('/api/sources', { sources: [] });
  const limits = await loadUsageSettings(api);
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

      <h3>Usage limits</h3>
      <p class="muted" style="margin:0 0 12px">Sets dashboard thresholds for latest scanned sessions and browser-local calendar weeks. These are tracking limits, not confirmed vendor quotas.</p>
      <label class="settings-check">
        <input id="weekly-enabled" type="checkbox" ${limits.weekly_enabled ? 'checked' : ''}>
        <span>Track weekly token limit</span>
      </label>
      <div class="settings-grid">
        <label>
          <span>Global session token limit</span>
          <input id="session-limit" type="number" min="0" step="1000" inputmode="numeric" value="${limits.session_tokens ?? ''}" placeholder="128000">
        </label>
        <label>
          <span>Global weekly token limit</span>
          <input id="weekly-limit" type="number" min="0" step="1000" inputmode="numeric" value="${limits.weekly_tokens ?? ''}" placeholder="1000000">
        </label>
        <label>
          <span>Week starts</span>
          <select id="week-start-day">
            ${weekDayOptions(limits.week_start_day)}
          </select>
        </label>
        <label>
          <span>Caution at (%)</span>
          <input id="weekly-caution" type="number" min="1" max="99" step="1" inputmode="numeric" value="${limits.caution_pct}">
        </label>
        <label>
          <span>Near limit at (%)</span>
          <input id="weekly-near" type="number" min="1" max="99" step="1" inputmode="numeric" value="${limits.near_pct}">
        </label>
        <label>
          <span>Active session window (minutes)</span>
          <input id="active-window" type="number" min="1" max="1440" step="1" inputmode="numeric" value="${limits.active_session_window_minutes}">
        </label>
        <label>
          <span>Claude session override</span>
          <input id="claude-session-limit" type="number" min="0" step="1000" inputmode="numeric" value="${limits.providers.claude.session_tokens ?? ''}" placeholder="global">
        </label>
        <label>
          <span>Claude weekly override</span>
          <input id="claude-weekly-limit" type="number" min="0" step="1000" inputmode="numeric" value="${limits.providers.claude.weekly_tokens ?? ''}" placeholder="global">
        </label>
        <label>
          <span>Codex session override</span>
          <input id="codex-session-limit" type="number" min="0" step="1000" inputmode="numeric" value="${limits.providers.codex.session_tokens ?? ''}" placeholder="global">
        </label>
        <label>
          <span>Codex weekly override</span>
          <input id="codex-weekly-limit" type="number" min="0" step="1000" inputmode="numeric" value="${limits.providers.codex.weekly_tokens ?? ''}" placeholder="global">
        </label>
      </div>
      <div class="flex" style="margin-top:12px">
        <button class="primary" id="save-limits">Save limits</button>
        <span id="limits-msg" class="muted"></span>
      </div>
      <p class="muted" style="margin:8px 0 0;font-size:11px">Weekly usage resets at 00:00 on the selected weekday in your browser's local time zone.</p>

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
    await api('/api/scan', { method: 'POST' });
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

  $('#save-limits').addEventListener('click', async () => {
    const payload = normalizeUsageSettings({
      session_tokens: $('#session-limit').value,
      weekly_tokens: $('#weekly-limit').value,
      weekly_enabled: $('#weekly-enabled').checked,
      week_start_day: $('#week-start-day').value,
      caution_pct: $('#weekly-caution').value,
      near_pct: $('#weekly-near').value,
      active_session_window_minutes: $('#active-window').value,
      providers: {
        claude: {
          session_tokens: $('#claude-session-limit').value,
          weekly_tokens: $('#claude-weekly-limit').value,
        },
        codex: {
          session_tokens: $('#codex-session-limit').value,
          weekly_tokens: $('#codex-weekly-limit').value,
        },
      },
    });
    const saved = await api('/api/settings/usage-limits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    $('#weekly-caution').value = String(saved.caution_pct);
    $('#weekly-near').value = String(saved.near_pct);
    $('#limits-msg').textContent = 'Saved.';
    $('#limits-msg').style.color = 'var(--good)';
  });
}

function weekDayOptions(selected) {
  return [
    ['0', 'Sunday'],
    ['1', 'Monday'],
    ['2', 'Tuesday'],
    ['3', 'Wednesday'],
    ['4', 'Thursday'],
    ['5', 'Friday'],
    ['6', 'Saturday'],
  ].map(([value, label]) => `
    <option value="${value}" ${Number(value) === selected ? 'selected' : ''}>${label}</option>
  `).join('');
}
