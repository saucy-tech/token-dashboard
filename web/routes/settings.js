// web/routes/settings.js — PATCHED: per-provider plan selectors, provider-enforced limits,
// 4 grouped sections (Scanning / Pricing / Usage Limits / Display)
import { api, dataSourcePanel, fmt, optionalApi, state, $ } from '/web/app.js';
import { loadUsageSettings, normalizeUsageSettings } from '/web/limits.js';

// ── Provider-enforced plan definitions ────────────────────────────────────────
// Source: Anthropic + OpenAI published limits, April 2026.
// Approximate — providers adjust without notice. Used to auto-populate limits.
const CLAUDE_PLANS = [
  { key:'claude-free',  label:'Claude.ai Free',      monthly:0,   session:20000,  hourly:40000,    weekly:200000,   note:'Free tier limits are low and context-dependent.' },
  { key:'claude-pro',   label:'Claude.ai Pro',        monthly:20,  session:100000, hourly:500000,   weekly:3000000,  note:'Pro limits reset weekly. Heavy tool-call sessions may hit session limits sooner.' },
  { key:'claude-max5',  label:'Claude.ai Max 5×',     monthly:100, session:200000, hourly:2000000,  weekly:15000000, note:'Max 5× provides 5× the usage of Pro per billing period.' },
  { key:'claude-max20', label:'Claude.ai Max 20×',    monthly:200, session:200000, hourly:4000000,  weekly:60000000, note:'Max 20× provides 20× the usage of Pro per billing period.' },
  { key:'claude-api',   label:'Anthropic API (PAYG)', monthly:null,session:null,   hourly:null,     weekly:null,     note:'API usage is metered. Set your own thresholds below.' },
];
const CODEX_PLANS = [
  { key:'codex-free',  label:'ChatGPT Free',          monthly:0,   session:8000,   hourly:32000,    weekly:200000,  note:'Free tier has strict message and token limits.' },
  { key:'codex-plus',  label:'ChatGPT Plus',          monthly:20,  session:32000,  hourly:300000,   weekly:2000000, note:'Plus limits reset monthly. Codex CLI draws from the same pool.' },
  { key:'codex-pro',   label:'ChatGPT Pro',           monthly:200, session:128000, hourly:2000000,  weekly:null,    note:'Pro has no hard weekly cap but OpenAI may throttle sustained heavy use.' },
  { key:'codex-api',   label:'OpenAI API (PAYG)',      monthly:null,session:null,   hourly:null,     weekly:null,    note:'API usage is metered. Limits depend on your org tier.' },
];

function claudePlan(key) { return CLAUDE_PLANS.find(p => p.key === key) || CLAUDE_PLANS[0]; }
function codexPlan(key)  { return CODEX_PLANS.find(p => p.key === key)  || CODEX_PLANS[0]; }

function planSelectHtml(plans, selectedKey, id) {
  return `<select id="${id}" style="width:100%">
    ${plans.map(p => `<option value="${p.key}" ${p.key===selectedKey?'selected':''}>
      ${p.label}${p.monthly!=null?` — $${p.monthly}/mo`:''}
    </option>`).join('')}
  </select>`;
}

function planLimitsPreviewHtml(plan, color) {
  function row(label, val) {
    return `<div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;padding:2px 0;">
      <span style="color:var(--muted);">${label}</span>
      <span style="color:var(--text);">${val!=null?Number(val).toLocaleString()+' tok':'no cap'}</span>
    </div>`;
  }
  return `<div style="margin-top:8px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:${color};margin-bottom:6px;">
      Enforced limits for this plan
    </div>
    ${row('Per session', plan.session)}
    ${row('Per hour',    plan.hourly)}
    ${row('Per week',    plan.weekly)}
    ${plan.note?`<div style="margin-top:6px;font-size:11px;color:var(--muted-2);line-height:1.4;">${plan.note}</div>`:''}
  </div>`;
}

// ── Week day helper ───────────────────────────────────────────────────────────
function weekDayOptions(selected) {
  return [['0','Sunday'],['1','Monday'],['2','Tuesday'],['3','Wednesday'],['4','Thursday'],['5','Friday'],['6','Saturday']]
    .map(([v,l]) => `<option value="${v}" ${Number(v)===selected?'selected':''}>${l}</option>`).join('');
}

// ── Main route ────────────────────────────────────────────────────────────────
export default async function(root) {
  const cur     = await api('/api/plan');
  const sources = await optionalApi('/api/sources', { sources:[] });
  const limits  = await loadUsageSettings(api);

  // Per-provider plan keys stored in localStorage
  const claudeKey = localStorage.getItem('td.claude-plan') || 'claude-pro';
  const codexKey  = localStorage.getItem('td.codex-plan')  || 'codex-plus';
  const cp = claudePlan(claudeKey);
  const xp = codexPlan(codexKey);

  const groupStyle = 'border:1px solid var(--border);border-radius:10px;background:var(--bg);padding:16px;margin-bottom:12px;';
  const labelStyle = 'display:grid;gap:6px;color:var(--muted);font-size:12px;';

  root.innerHTML = `
  <div style="max-width:860px;">

    <!-- ── 1. Scanning ─────────────────────────────────────── -->
    <div style="margin-bottom:16px">
      ${dataSourcePanel(sources, { scanButton:true })}
    </div>
    <div style="margin-bottom:16px">
      <h2 style="margin:0 0 14px;font-size:16px;letter-spacing:-.01em;">Settings</h2>
    </div>

    <!-- ── 2. Pricing / Plans ──────────────────────────────── -->
    <div style="${groupStyle}">
      <h4 style="margin:0 0 4px;font-size:13px;">Pricing &amp; Plans</h4>
      <p style="margin:0 0 14px;color:var(--muted);font-size:12px;">
        Select the plan you're on for each provider. Limits auto-populate from what that provider enforces.
        These are <em>approximate</em> — providers adjust them without notice.
      </p>

      <!-- Claude plan -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
        <div>
          <label style="${labelStyle}">
            <span style="color:var(--provider-claude);font-weight:600;">Anthropic / Claude plan</span>
            ${planSelectHtml(CLAUDE_PLANS, claudeKey, 'claude-plan')}
          </label>
          <div id="claude-plan-preview">${planLimitsPreviewHtml(cp, 'var(--provider-claude)')}</div>
        </div>
        <div>
          <label style="${labelStyle}">
            <span style="color:var(--provider-codex);font-weight:600;">OpenAI / Codex plan</span>
            ${planSelectHtml(CODEX_PLANS, codexKey, 'codex-plan')}
          </label>
          <div id="codex-plan-preview">${planLimitsPreviewHtml(xp, 'var(--provider-codex)')}</div>
        </div>
      </div>

      <!-- Legacy single-plan for backward compat with /api/plan -->
      <details style="margin-bottom:10px;">
        <summary style="font-size:12px;color:var(--muted);cursor:pointer;">API cost context (legacy plan selector)</summary>
        <div style="margin-top:10px;">
          <p style="margin:0 0 10px;color:var(--muted);font-size:12px;">Used only for the "pay X/mo on Plan" subtitle on cost estimates. Does not affect limit thresholds.</p>
          <div style="display:flex;gap:8px;align-items:center;">
            <select id="plan" style="flex:1;">
              ${Object.entries(cur.pricing.plans).map(([k,v]) =>
                `<option value="${k}" ${k===cur.plan?'selected':''}>${v.label}${v.monthly?` — $${v.monthly}/mo`:''}</option>`
              ).join('')}
            </select>
            <button class="primary" id="save-plan" style="white-space:nowrap;">Save</button>
            <span id="plan-msg" class="muted" style="font-size:12px;"></span>
          </div>
        </div>
      </details>

      <!-- Pricing table -->
      <h4 style="margin:14px 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;">Token rates (pricing.json)</h4>
      <table style="font-size:12px;">
        <thead><tr>
          <th>model</th><th class="num">input</th><th class="num">output</th>
          <th class="num">cache rd</th><th class="num">cache 5m</th><th class="num">cache 1h</th>
        </tr></thead>
        <tbody>
          ${Object.entries(cur.pricing.models).map(([k,v]) => `
            <tr>
              <td><span class="badge ${v.tier}">${k}</span></td>
              <td class="num">$${v.input.toFixed(2)}</td>
              <td class="num">$${v.output.toFixed(2)}</td>
              <td class="num">$${v.cache_read.toFixed(2)}</td>
              <td class="num">$${v.cache_create_5m.toFixed(2)}</td>
              <td class="num">$${v.cache_create_1h.toFixed(2)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p style="margin:6px 0 0;color:var(--muted);font-size:11px;">Rates per 1M tokens, USD. Edit pricing.json and reload to update.</p>
    </div>

    <!-- ── 3. Usage Limits ─────────────────────────────────── -->
    <div style="${groupStyle}">
      <h4 style="margin:0 0 4px;font-size:13px;">Usage Limits</h4>
      <p style="margin:0 0 14px;color:var(--muted);font-size:12px;">
        Auto-populated from your plan selections above. Fine-tune if needed — the dashboard tracks these locally
        and does not call provider quota APIs.
      </p>

      <!-- Auto-fill from plans -->
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center;">
        <span style="color:var(--muted);font-size:12px;">Auto-fill from plans:</span>
        <button class="ghost" id="autofill-claude" style="font-size:12px;color:var(--provider-claude);">Claude plan limits</button>
        <button class="ghost" id="autofill-codex"  style="font-size:12px;color:var(--provider-codex);">Codex plan limits</button>
        <button class="ghost" id="autofill-min"    style="font-size:12px;">More conservative of both</button>
      </div>

      <label class="settings-check" style="margin-bottom:12px;">
        <input id="weekly-enabled" type="checkbox" ${limits.weekly_enabled?'checked':''} data-limit-input>
        <span>Track weekly token limit</span>
      </label>

      <!-- Global defaults -->
      <div class="settings-group" style="margin-bottom:10px;">
        <h4 style="margin:0 0 10px;">Global defaults</h4>
        <div class="settings-grid">
          <label style="${labelStyle}">
            <span style="color:var(--text);font-weight:600;">Session token limit</span>
            <input id="session-limit" data-limit-input type="number" min="0" step="1000" inputmode="numeric"
              value="${limits.session_tokens??''}" placeholder="e.g. 100000">
          </label>
          <label style="${labelStyle}">
            <span style="color:var(--text);font-weight:600;">Hourly token limit</span>
            <input id="hourly-limit" data-limit-input type="number" min="0" step="1000" inputmode="numeric"
              value="${limits.hourly_tokens??''}" placeholder="e.g. 500000">
          </label>
          <label style="${labelStyle}">
            <span style="color:var(--text);font-weight:600;">Weekly token limit</span>
            <input id="weekly-limit" data-limit-input type="number" min="0" step="1000" inputmode="numeric"
              value="${limits.weekly_tokens??''}" placeholder="e.g. 3000000">
          </label>
          <label style="${labelStyle}">
            <span style="color:var(--text);font-weight:600;">Week starts</span>
            <select id="week-start-day" data-limit-input>${weekDayOptions(limits.week_start_day)}</select>
          </label>
        </div>
      </div>

      <!-- Per-provider overrides -->
      <div class="settings-group provider-surface provider-claude" style="margin-bottom:10px;">
        <h4 style="margin:0 0 4px;">Claude overrides <span style="font-size:11px;font-weight:400;color:var(--muted);">Leave blank to inherit global</span></h4>
        <div class="settings-grid">
          <label style="${labelStyle}"><span>Session</span>
            <input id="claude-session-limit" data-limit-input type="number" min="0" step="1000"
              value="${limits.providers.claude.session_tokens??''}" placeholder="inherit"></label>
          <label style="${labelStyle}"><span>Hourly</span>
            <input id="claude-hourly-limit" data-limit-input type="number" min="0" step="1000"
              value="${limits.providers.claude.hourly_tokens??''}" placeholder="inherit"></label>
          <label style="${labelStyle}"><span>Weekly</span>
            <input id="claude-weekly-limit" data-limit-input type="number" min="0" step="1000"
              value="${limits.providers.claude.weekly_tokens??''}" placeholder="inherit"></label>
        </div>
      </div>
      <div class="settings-group provider-surface provider-codex" style="margin-bottom:10px;">
        <h4 style="margin:0 0 4px;">Codex overrides <span style="font-size:11px;font-weight:400;color:var(--muted);">Leave blank to inherit global</span></h4>
        <div class="settings-grid">
          <label style="${labelStyle}"><span>Session</span>
            <input id="codex-session-limit" data-limit-input type="number" min="0" step="1000"
              value="${limits.providers.codex.session_tokens??''}" placeholder="inherit"></label>
          <label style="${labelStyle}"><span>Hourly</span>
            <input id="codex-hourly-limit" data-limit-input type="number" min="0" step="1000"
              value="${limits.providers.codex.hourly_tokens??''}" placeholder="inherit"></label>
          <label style="${labelStyle}"><span>Weekly</span>
            <input id="codex-weekly-limit" data-limit-input type="number" min="0" step="1000"
              value="${limits.providers.codex.weekly_tokens??''}" placeholder="inherit"></label>
        </div>
      </div>

      <!-- Thresholds -->
      <div class="settings-group" style="margin-bottom:10px;">
        <h4 style="margin:0 0 10px;">Alert thresholds</h4>
        <div class="settings-grid">
          <label style="${labelStyle}">
            <span style="color:var(--text);font-weight:600;">Caution at (%)</span>
            <input id="weekly-caution" data-limit-input type="number" min="1" max="99" step="1" value="${limits.caution_pct}">
          </label>
          <label style="${labelStyle}">
            <span style="color:var(--text);font-weight:600;">Near limit at (%)</span>
            <input id="weekly-near" data-limit-input type="number" min="1" max="99" step="1" value="${limits.near_pct}">
          </label>
          <label style="${labelStyle}">
            <span style="color:var(--text);font-weight:600;">Active session window (min)</span>
            <input id="active-window" data-limit-input type="number" min="1" max="1440" step="1" value="${limits.active_session_window_minutes}">
          </label>
        </div>
      </div>

      <!-- Effective preview -->
      <div class="settings-group" style="margin-bottom:10px;">
        <h4 style="margin:0 0 8px;">Effective limits preview</h4>
        <div id="effective-preview" class="effective-preview"></div>
      </div>

      <div id="limits-validation" class="settings-validation"></div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:12px;">
        <button class="primary" id="save-limits">Save limits</button>
        <span id="limits-msg" class="muted" style="font-size:12px;"></span>
      </div>
      <p style="margin:8px 0 0;color:var(--muted);font-size:11px;">
        Weekly usage resets at 00:00 on the selected weekday in your browser's local time zone.
      </p>
    </div>

    <!-- ── 4. Display ──────────────────────────────────────── -->
    <div style="${groupStyle}">
      <h4 style="margin:0 0 12px;font-size:13px;">Display</h4>
      <label class="settings-check" style="margin-bottom:10px;">
        <input type="checkbox" id="pct-left-toggle" ${localStorage.getItem('td.limits-show-used')==='0'?'checked':''}
          style="width:auto;">
        <span>Show "% left" instead of "% used" in limits strip</span>
      </label>
      <p style="margin:0 0 10px;color:var(--muted);font-size:12px;">
        Press <code>Cmd/Ctrl + B</code> anywhere to blur prompt text and sensitive content for screenshots.
      </p>
      <h4 style="margin:10px 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;">Known limitations</h4>
      <ul class="muted limitation-list">
        <li>Costs are token-rate estimates. Subscription plans are flat monthly prices and are not allocated per turn.</li>
        <li>Unknown model IDs are omitted from cost totals unless their name matches a known fallback family (Claude tiers or GPT/Codex naming).</li>
        <li>Totals include only supported local Claude Code and Codex logs that have been scanned into the SQLite cache.</li>
        <li>Warp and server-side Cowork sessions are not included because they do not have a confirmed local usage source here.</li>
        <li>Plan token limits shown above are approximate and may not match what Anthropic/OpenAI actually enforces at any given time.</li>
      </ul>
    </div>

  </div>`;

  // ── scan now ──────────────────────────────────────────────────────────────
  root.querySelector('[data-scan-now]')?.addEventListener('click', async e => {
    e.currentTarget.textContent = 'Scanning…';
    await api('/api/scan', { method:'POST' });
    window.dispatchEvent(new Event('hashchange'));
  });

  // ── legacy plan save ──────────────────────────────────────────────────────
  root.querySelector('#save-plan')?.addEventListener('click', async () => {
    const plan = $('#plan').value;
    await fetch('/api/plan', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ plan }) });
    state.plan = plan;
    document.getElementById('plan-pill').textContent = plan;
    $('#plan-msg').textContent = 'Saved.';
    $('#plan-msg').style.color = 'var(--good)';
  });

  // ── provider plan selectors — auto-fill limits ────────────────────────────
  root.querySelector('#claude-plan')?.addEventListener('change', function() {
    localStorage.setItem('td.claude-plan', this.value);
    const p = claudePlan(this.value);
    root.querySelector('#claude-plan-preview').innerHTML = planLimitsPreviewHtml(p, 'var(--provider-claude)');
  });
  root.querySelector('#codex-plan')?.addEventListener('change', function() {
    localStorage.setItem('td.codex-plan', this.value);
    const p = codexPlan(this.value);
    root.querySelector('#codex-plan-preview').innerHTML = planLimitsPreviewHtml(p, 'var(--provider-codex)');
  });

  // auto-fill buttons
  root.querySelector('#autofill-claude')?.addEventListener('click', () => {
    const p = claudePlan(localStorage.getItem('td.claude-plan') || 'claude-pro');
    if (p.session) $('#session-limit').value = p.session;
    if (p.hourly)  $('#hourly-limit').value  = p.hourly;
    if (p.weekly)  $('#weekly-limit').value  = p.weekly;
    if (p.session) $('#claude-session-limit').value = p.session;
    if (p.hourly)  $('#claude-hourly-limit').value  = p.hourly;
    if (p.weekly)  $('#claude-weekly-limit').value  = p.weekly;
    refreshLimitsUi();
    $('#limits-msg').textContent = 'Claude plan limits applied. Save to persist.';
    $('#limits-msg').style.color = 'var(--muted)';
  });
  root.querySelector('#autofill-codex')?.addEventListener('click', () => {
    const p = codexPlan(localStorage.getItem('td.codex-plan') || 'codex-plus');
    if (p.session) $('#session-limit').value = p.session;
    if (p.hourly)  $('#hourly-limit').value  = p.hourly;
    if (p.weekly)  $('#weekly-limit').value  = p.weekly;
    if (p.session) $('#codex-session-limit').value = p.session;
    if (p.hourly)  $('#codex-hourly-limit').value  = p.hourly;
    if (p.weekly)  $('#codex-weekly-limit').value  = p.weekly;
    refreshLimitsUi();
    $('#limits-msg').textContent = 'Codex plan limits applied. Save to persist.';
    $('#limits-msg').style.color = 'var(--muted)';
  });
  root.querySelector('#autofill-min')?.addEventListener('click', () => {
    const c = claudePlan(localStorage.getItem('td.claude-plan') || 'claude-pro');
    const x = codexPlan(localStorage.getItem('td.codex-plan')  || 'codex-plus');
    const minNN = (a, b) => a==null&&b==null?null:a==null?b:b==null?a:Math.min(a,b);
    const sess = minNN(c.session, x.session);
    const hour = minNN(c.hourly,  x.hourly);
    const week = minNN(c.weekly,  x.weekly);
    if (sess) $('#session-limit').value = sess;
    if (hour) $('#hourly-limit').value  = hour;
    if (week) $('#weekly-limit').value  = week;
    if (c.session) $('#claude-session-limit').value = c.session;
    if (c.hourly)  $('#claude-hourly-limit').value  = c.hourly;
    if (c.weekly)  $('#claude-weekly-limit').value  = c.weekly;
    if (x.session) $('#codex-session-limit').value  = x.session;
    if (x.hourly)  $('#codex-hourly-limit').value   = x.hourly;
    if (x.weekly)  $('#codex-weekly-limit').value   = x.weekly;
    refreshLimitsUi();
    $('#limits-msg').textContent = 'Conservative (minimum) limits applied. Save to persist.';
    $('#limits-msg').style.color = 'var(--muted)';
  });

  // ── limit inputs — live validation + preview ──────────────────────────────
  root.querySelectorAll('[data-limit-input]').forEach(el => {
    el.addEventListener('input',  refreshLimitsUi);
    el.addEventListener('change', refreshLimitsUi);
  });

  // ── save limits ───────────────────────────────────────────────────────────
  root.querySelector('#save-limits')?.addEventListener('click', async () => {
    const validation = validateLimitForm();
    if (!validation.ok) return;
    const payload = buildUsagePayload();
    const saved = await api('/api/settings/usage-limits', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    });
    $('#weekly-caution').value = String(saved.caution_pct);
    $('#weekly-near').value    = String(saved.near_pct);
    $('#limits-msg').textContent = 'Saved.';
    $('#limits-msg').style.color = 'var(--good)';
    refreshLimitsUi();
  });

  // ── display toggle ────────────────────────────────────────────────────────
  root.querySelector('#pct-left-toggle')?.addEventListener('change', function() {
    localStorage.setItem('td.limits-show-used', this.checked ? '0' : '1');
  });

  refreshLimitsUi();
}

// ── helpers ───────────────────────────────────────────────────────────────────
function buildUsagePayload() {
  return normalizeUsageSettings({
    session_tokens: $('#session-limit').value,
    hourly_tokens:  $('#hourly-limit').value,
    weekly_tokens:  $('#weekly-limit').value,
    weekly_enabled: $('#weekly-enabled').checked,
    week_start_day: $('#week-start-day').value,
    caution_pct:    $('#weekly-caution').value,
    near_pct:       $('#weekly-near').value,
    active_session_window_minutes: $('#active-window').value,
    providers: {
      claude: {
        session_tokens: $('#claude-session-limit').value,
        hourly_tokens:  $('#claude-hourly-limit').value,
        weekly_tokens:  $('#claude-weekly-limit').value,
      },
      codex: {
        session_tokens: $('#codex-session-limit').value,
        hourly_tokens:  $('#codex-hourly-limit').value,
        weekly_tokens:  $('#codex-weekly-limit').value,
      },
    },
  });
}

function validateLimitForm() {
  const errors = [];
  const caution      = parseIntStrict($('#weekly-caution').value);
  const near         = parseIntStrict($('#weekly-near').value);
  const activeWindow = parseIntStrict($('#active-window').value);
  const weeklyEnabled = $('#weekly-enabled').checked;
  const fields = ['session-limit','hourly-limit','weekly-limit',
    'claude-session-limit','claude-hourly-limit','claude-weekly-limit',
    'codex-session-limit','codex-hourly-limit','codex-weekly-limit'];
  const anyNaN = fields.some(id => {
    const el = $(`#${id}`);
    return el && el.value !== '' && Number.isNaN(parseOptionalPositive(el.value));
  });
  if (!(caution >= 1 && caution <= 99))      errors.push('Caution threshold must be 1–99.');
  if (!(near >= 1 && near <= 99))            errors.push('Near threshold must be 1–99.');
  if (caution >= near)                        errors.push('Near threshold must be greater than caution.');
  if (!(activeWindow >= 1 && activeWindow <= 1440)) errors.push('Active session window must be 1–1440 min.');
  if (anyNaN)                                errors.push('Limit values must be positive whole numbers or empty.');
  const msg  = $('#limits-validation');
  const save = $('#save-limits');
  if (errors.length) {
    msg.textContent  = errors[0];
    msg.className    = 'settings-validation error';
    save.disabled    = true;
  } else {
    msg.textContent  = 'Looks good. Effective preview updates as you type.';
    msg.className    = 'settings-validation ok';
    save.disabled    = false;
  }
  return { ok: !errors.length };
}

function refreshLimitsUi() {
  validateLimitForm();
  renderEffectivePreview(buildUsagePayload());
}

function renderEffectivePreview(payload) {
  const ep = $('#effective-preview');
  if (!ep) return;
  ep.innerHTML = [
    effectiveProviderCard(payload, 'claude', 'Anthropic / Claude', 'provider-claude'),
    effectiveProviderCard(payload, 'codex',  'OpenAI / Codex',     'provider-codex'),
  ].join('');
}

function effectiveProviderCard(payload, key, label, cls) {
  const p          = payload.providers?.[key] || {};
  const sess       = p.session_tokens  || payload.session_tokens  || null;
  const hour       = p.hourly_tokens   || payload.hourly_tokens   || null;
  const week       = payload.weekly_enabled ? (p.weekly_tokens || payload.weekly_tokens || null) : null;
  const src = (override, global) => override ? `${label} override` : global ? 'global default' : 'not set';
  return `
    <div class="effective-card ${cls}">
      <strong>${label}</strong>
      <div>Session: <b>${sess?Number(sess).toLocaleString()+' tok':'not set'}</b>
        <span class="muted"> (${src(p.session_tokens, payload.session_tokens)})</span></div>
      <div>Hourly: <b>${hour?Number(hour).toLocaleString()+' tok':'not set'}</b>
        <span class="muted"> (${src(p.hourly_tokens, payload.hourly_tokens)})</span></div>
      <div>Weekly: <b>${!payload.weekly_enabled?'disabled':week?Number(week).toLocaleString()+' tok':'not set'}</b>
        <span class="muted"> (${!payload.weekly_enabled?'weekly tracking off':src(p.weekly_tokens, payload.weekly_tokens)})</span></div>
    </div>`;
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
