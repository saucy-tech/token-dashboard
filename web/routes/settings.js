import { api, dataSourcePanel, optionalApi, state, $ } from '/web/app.js';

export default async function (root) {
  const cur = await api('/api/plan');
  const sources = await optionalApi('/api/sources', { sources: [] });
  const plans = Object.entries(cur.pricing.plans);
  const sessionLimit = readLimit('td.session-limit-tokens');
  const weeklyLimit = readLimit('td.weekly-limit-tokens');
  const weeklyEnabled = readWeeklyEnabled();
  const cautionPct = readThreshold('td.weekly-caution-pct', 75);
  const nearPct = readThreshold('td.weekly-near-pct', 90);
  const weekStartDay = readWeekStartDay();
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
      <p class="muted" style="margin:0 0 12px">Sets local dashboard thresholds for the current session and calendar week. These are tracking limits, not confirmed vendor quotas.</p>
      <label class="settings-check">
        <input id="weekly-enabled" type="checkbox" ${weeklyEnabled ? 'checked' : ''}>
        <span>Track weekly token limit</span>
      </label>
      <div class="settings-grid">
        <label>
          <span>Session token limit</span>
          <input id="session-limit" type="number" min="0" step="1000" inputmode="numeric" value="${sessionLimit ?? ''}" placeholder="128000">
        </label>
        <label>
          <span>Weekly token limit</span>
          <input id="weekly-limit" type="number" min="0" step="1000" inputmode="numeric" value="${weeklyLimit ?? ''}" placeholder="1000000">
        </label>
        <label>
          <span>Week starts</span>
          <select id="week-start-day">
            ${weekDayOptions(weekStartDay)}
          </select>
        </label>
        <label>
          <span>Caution at (%)</span>
          <input id="weekly-caution" type="number" min="1" max="99" step="1" inputmode="numeric" value="${cautionPct}">
        </label>
        <label>
          <span>Near limit at (%)</span>
          <input id="weekly-near" type="number" min="1" max="99" step="1" inputmode="numeric" value="${nearPct}">
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

  $('#save-limits').addEventListener('click', () => {
    saveLimit('td.session-limit-tokens', $('#session-limit').value);
    saveLimit('td.weekly-limit-tokens', $('#weekly-limit').value);
    saveWeeklyEnabled($('#weekly-enabled').checked);
    saveWeekStartDay($('#week-start-day').value);
    saveThresholds($('#weekly-caution').value, $('#weekly-near').value);
    $('#limits-msg').textContent = 'Saved.';
    $('#limits-msg').style.color = 'var(--good)';
  });
}

function readLimit(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function saveLimit(key, raw) {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, String(Math.round(value)));
  }
}

function readWeeklyEnabled() {
  return localStorage.getItem('td.weekly-limit-enabled') !== '0';
}

function saveWeeklyEnabled(enabled) {
  localStorage.setItem('td.weekly-limit-enabled', enabled ? '1' : '0');
}

function readThreshold(key, fallback) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value >= 1 && value <= 99 ? value : fallback;
}

function saveThresholds(cautionRaw, nearRaw) {
  let caution = Number(cautionRaw);
  let near = Number(nearRaw);
  if (!Number.isFinite(caution)) caution = 75;
  if (!Number.isFinite(near)) near = 90;
  caution = Math.max(1, Math.min(99, Math.round(caution)));
  near = Math.max(1, Math.min(99, Math.round(near)));
  if (near <= caution) near = Math.min(99, caution + 1);
  localStorage.setItem('td.weekly-caution-pct', String(caution));
  localStorage.setItem('td.weekly-near-pct', String(near));
  $('#weekly-caution').value = String(caution);
  $('#weekly-near').value = String(near);
}

function readWeekStartDay() {
  const raw = localStorage.getItem('td.week-start-day');
  if (raw == null || raw === '') return 1;
  const value = Number(raw);
  // Default assumption: weekly limit windows reset Monday at local midnight.
  // The app has no account-level provider quota API, so this browser setting
  // controls dashboard tracking only.
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 1;
}

function saveWeekStartDay(raw) {
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 0 && value <= 6) {
    localStorage.setItem('td.week-start-day', String(value));
  } else {
    localStorage.removeItem('td.week-start-day');
  }
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
