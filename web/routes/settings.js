import { api, dataSourcePanel, optionalApi, state, $ } from '/web/app.js';
import { loadUsageSettings, normalizeUsageSettings } from '/web/limits.js';

const LIMIT_PRESETS = {
  conservative: {
    label: 'Conservative',
    session_tokens: 90000,
    weekly_tokens: 500000,
    caution_pct: 70,
    near_pct: 85,
    active_session_window_minutes: 20,
  },
  balanced: {
    label: 'Balanced',
    session_tokens: 128000,
    weekly_tokens: 1000000,
    caution_pct: 75,
    near_pct: 90,
    active_session_window_minutes: 20,
  },
  aggressive: {
    label: 'Aggressive',
    session_tokens: 200000,
    weekly_tokens: 1800000,
    caution_pct: 82,
    near_pct: 95,
    active_session_window_minutes: 30,
  },
};

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
      <p class="muted" style="margin:0 0 12px">Tracking thresholds for latest scanned sessions and browser-local calendar weeks. These do not call provider quota APIs.</p>
      <div class="limit-presets">
        <span class="muted">Presets</span>
        ${Object.entries(LIMIT_PRESETS).map(([key, preset]) => `
          <button class="ghost" data-preset="${key}">${preset.label}</button>
        `).join('')}
      </div>
      <div class="settings-group">
        <h4>Global defaults</h4>
        <label class="settings-check">
          <input id="weekly-enabled" type="checkbox" ${limits.weekly_enabled ? 'checked' : ''} data-limit-input>
          <span>Track weekly token limit</span>
        </label>
        <div class="settings-grid">
          <label>
            <span>Default session token limit</span>
            <input id="session-limit" data-limit-input type="number" min="0" step="1000" inputmode="numeric" value="${limits.session_tokens ?? ''}" placeholder="128000">
          </label>
          <label>
            <span>Default weekly token limit</span>
            <input id="weekly-limit" data-limit-input type="number" min="0" step="1000" inputmode="numeric" value="${limits.weekly_tokens ?? ''}" placeholder="1000000">
          </label>
          <label>
            <span>Week starts</span>
            <select id="week-start-day" data-limit-input>
              ${weekDayOptions(limits.week_start_day)}
            </select>
          </label>
          <label>
            <span>Caution at (%)</span>
            <input id="weekly-caution" data-limit-input type="number" min="1" max="99" step="1" inputmode="numeric" value="${limits.caution_pct}">
          </label>
          <label>
            <span>Near limit at (%)</span>
            <input id="weekly-near" data-limit-input type="number" min="1" max="99" step="1" inputmode="numeric" value="${limits.near_pct}">
          </label>
          <label>
            <span>Active session window (minutes)</span>
            <input id="active-window" data-limit-input type="number" min="1" max="1440" step="1" inputmode="numeric" value="${limits.active_session_window_minutes}">
          </label>
        </div>
      </div>
      <div class="settings-group provider-surface provider-claude">
        <h4>Claude overrides</h4>
        <p class="muted" style="margin:-4px 0 10px">Optional values. Leave blank to inherit global defaults.</p>
        <div class="settings-grid">
          <label>
            <span>Claude session override</span>
            <input id="claude-session-limit" data-limit-input type="number" min="0" step="1000" inputmode="numeric" value="${limits.providers.claude.session_tokens ?? ''}" placeholder="inherit global">
          </label>
          <label>
            <span>Claude weekly override</span>
            <input id="claude-weekly-limit" data-limit-input type="number" min="0" step="1000" inputmode="numeric" value="${limits.providers.claude.weekly_tokens ?? ''}" placeholder="inherit global">
          </label>
        </div>
      </div>
      <div class="settings-group provider-surface provider-codex">
        <h4>Codex overrides</h4>
        <p class="muted" style="margin:-4px 0 10px">Optional values. Leave blank to inherit global defaults.</p>
        <div class="settings-grid">
          <label>
            <span>Codex session override</span>
            <input id="codex-session-limit" data-limit-input type="number" min="0" step="1000" inputmode="numeric" value="${limits.providers.codex.session_tokens ?? ''}" placeholder="inherit global">
          </label>
          <label>
            <span>Codex weekly override</span>
            <input id="codex-weekly-limit" data-limit-input type="number" min="0" step="1000" inputmode="numeric" value="${limits.providers.codex.weekly_tokens ?? ''}" placeholder="inherit global">
          </label>
        </div>
      </div>
      <div class="settings-group">
        <h4>Effective limits preview</h4>
        <p class="muted" style="margin:-4px 0 10px">What each provider will actually use after defaults + overrides are resolved.</p>
        <div id="effective-preview" class="effective-preview"></div>
      </div>
      <div id="limits-validation" class="settings-validation"></div>
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

  $('#save-limits').addEventListener('click', async () => {
    const validation = validateLimitForm();
    if (!validation.ok) return;
    const payload = buildUsagePayload();
    const saved = await api('/api/settings/usage-limits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    $('#weekly-caution').value = String(saved.caution_pct);
    $('#weekly-near').value = String(saved.near_pct);
    $('#limits-msg').textContent = 'Saved.';
    $('#limits-msg').style.color = 'var(--good)';
    refreshLimitsUi();
  });

  root.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });
  root.querySelectorAll('[data-limit-input]').forEach(el => {
    el.addEventListener('input', refreshLimitsUi);
    el.addEventListener('change', refreshLimitsUi);
  });
  refreshLimitsUi();
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

function applyPreset(key) {
  const preset = LIMIT_PRESETS[key];
  if (!preset) return;
  $('#session-limit').value = String(preset.session_tokens);
  $('#weekly-limit').value = String(preset.weekly_tokens);
  $('#weekly-caution').value = String(preset.caution_pct);
  $('#weekly-near').value = String(preset.near_pct);
  $('#active-window').value = String(preset.active_session_window_minutes);
  $('#weekly-enabled').checked = true;
  $('#limits-msg').textContent = `${preset.label} preset applied. Save to persist.`;
  $('#limits-msg').style.color = 'var(--muted)';
  refreshLimitsUi();
}

function buildUsagePayload() {
  return normalizeUsageSettings({
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
}

function validateLimitForm() {
  const errors = [];
  const weeklyEnabled = $('#weekly-enabled').checked;
  const caution = parseIntStrict($('#weekly-caution').value);
  const near = parseIntStrict($('#weekly-near').value);
  const activeWindow = parseIntStrict($('#active-window').value);
  const globalSession = parseOptionalPositive($('#session-limit').value);
  const globalWeekly = parseOptionalPositive($('#weekly-limit').value);
  const claudeSession = parseOptionalPositive($('#claude-session-limit').value);
  const claudeWeekly = parseOptionalPositive($('#claude-weekly-limit').value);
  const codexSession = parseOptionalPositive($('#codex-session-limit').value);
  const codexWeekly = parseOptionalPositive($('#codex-weekly-limit').value);

  if (!(caution >= 1 && caution <= 99)) errors.push('Caution threshold must be between 1 and 99.');
  if (!(near >= 1 && near <= 99)) errors.push('Near threshold must be between 1 and 99.');
  if (caution >= near) errors.push('Near threshold must be greater than caution threshold.');
  if (!(activeWindow >= 1 && activeWindow <= 1440)) errors.push('Active session window must be between 1 and 1440 minutes.');
  if (Number.isNaN(globalSession) || Number.isNaN(globalWeekly) || Number.isNaN(claudeSession) || Number.isNaN(claudeWeekly) || Number.isNaN(codexSession) || Number.isNaN(codexWeekly)) {
    errors.push('Limit values must be positive whole numbers or empty to inherit.');
  }
  if (weeklyEnabled && !globalWeekly && !claudeWeekly && !codexWeekly) {
    errors.push('Weekly tracking is enabled, but no weekly threshold is configured.');
  }

  const msg = $('#limits-validation');
  const save = $('#save-limits');
  if (errors.length) {
    msg.textContent = errors[0];
    msg.className = 'settings-validation error';
    save.disabled = true;
  } else {
    msg.textContent = 'Looks good. Effective preview updates as you type.';
    msg.className = 'settings-validation ok';
    save.disabled = false;
  }
  return { ok: !errors.length, errors };
}

function refreshLimitsUi() {
  const validation = validateLimitForm();
  const payload = buildUsagePayload();
  renderEffectivePreview(payload);
  if (validation.ok && $('#limits-msg').textContent === 'Saved.') {
    $('#limits-msg').textContent = 'Saved.';
  }
}

function renderEffectivePreview(payload) {
  $('#effective-preview').innerHTML = [
    effectiveProviderCopy(payload, 'claude', 'Claude Code'),
    effectiveProviderCopy(payload, 'codex', 'Codex'),
  ].join('');
}

function effectiveProviderCopy(payload, providerKey, label) {
  const provider = payload.providers?.[providerKey] || {};
  const sessionLimit = provider.session_tokens || payload.session_tokens || null;
  const weeklyLimit = payload.weekly_enabled ? (provider.weekly_tokens || payload.weekly_tokens || null) : null;
  const sessionSource = provider.session_tokens ? `${label} override` : (payload.session_tokens ? 'global default' : 'not configured');
  const weeklySource = !payload.weekly_enabled
    ? 'weekly tracking disabled'
    : (provider.weekly_tokens ? `${label} override` : (payload.weekly_tokens ? 'global default' : 'not configured'));
  return `
    <div class="effective-card ${providerKey === 'claude' ? 'provider-claude' : 'provider-codex'}">
      <strong>${label}</strong>
      <div>Session limit: <b>${sessionLimit ? fmtCompact(sessionLimit) : 'not set'}</b> (${sessionSource})</div>
      <div>Weekly limit: <b>${weeklyLimit ? fmtCompact(weeklyLimit) : 'not set'}</b> (${weeklySource})</div>
      <div class="muted">Effective result: ${label} will use ${sessionLimit ? fmtCompact(sessionLimit) : 'no'} session threshold and ${weeklyLimit ? fmtCompact(weeklyLimit) : 'no'} weekly threshold.</div>
    </div>`;
}

function fmtCompact(value) {
  return Number(value || 0).toLocaleString();
}

function parseOptionalPositive(raw) {
  if (raw == null || raw === '') return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return Number.NaN;
  return n;
}

function parseIntStrict(raw) {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? n : Number.NaN;
}
