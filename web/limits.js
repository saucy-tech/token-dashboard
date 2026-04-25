export function billableTokens(row) {
  if (!row) return 0;
  if (row.billable_tokens != null) return row.billable_tokens || 0;
  return (row.input_tokens || 0) + (row.output_tokens || 0)
    + (row.cache_create_5m_tokens || 0) + (row.cache_create_1h_tokens || 0);
}

export function currentWeekWindow(now = new Date(), weekStartDay = 1) {
  // Default assumption: dashboard weekly limits reset Monday at local 00:00.
  // Callers may pass a different browser-local start weekday from Settings.
  const startDay = weekStartDay !== null && weekStartDay !== ''
    && Number.isInteger(weekStartDay) && weekStartDay >= 0 && weekStartDay <= 6
    ? weekStartDay
    : 1;
  const start = new Date(now);
  const daysSinceStart = (now.getDay() - startDay + 7) % 7;
  start.setDate(now.getDate() - daysSinceStart);
  start.setHours(0, 0, 0, 0);
  const reset = new Date(start);
  reset.setDate(start.getDate() + 7);
  return { start, reset, weekStartDay: startDay };
}

export function rollingHourWindow(now = new Date()) {
  const end = new Date(now);
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return { start, end };
}

export function limitStatus(used, limit, thresholds = { cautionPct: 75, nearPct: 90 }) {
  if (!limit) return { pct: null, cls: 'unset', label: 'not set', name: 'Not set' };
  const pct = used / limit;
  const percent = Math.round(pct * 100);
  const cautionPct = Number.isFinite(thresholds.cautionPct) ? thresholds.cautionPct : 75;
  const nearPct = Number.isFinite(thresholds.nearPct) ? thresholds.nearPct : 90;
  if (pct >= 1) return { pct, cls: 'exceeded', label: `${percent}% used`, name: 'Exceeded' };
  if (percent >= nearPct) return { pct, cls: 'near', label: `${percent}% used`, name: 'Near limit' };
  if (percent >= cautionPct) return { pct, cls: 'caution', label: `${percent}% used`, name: 'Caution' };
  return { pct, cls: 'normal', label: `${percent}% used`, name: 'Normal' };
}

export function progressPct(status) {
  if (!status || status.pct == null) return 0;
  return Math.max(0, Math.min(100, Math.round(status.pct * 100)));
}

export function limitForProvider(settings, providerKey = 'all') {
  const base = normalizeUsageSettings(settings);
  const key = (providerKey || 'all').toLowerCase();
  const override = key === 'all' ? null : base.providers?.[key];
  const sessionTokens = override?.session_tokens || base.session_tokens || null;
  const hourlyTokens = override?.hourly_tokens || base.hourly_tokens || null;
  const weeklyConfigured = override?.weekly_tokens || base.weekly_tokens || null;
  return {
    sessionTokens,
    hourlyTokens,
    weeklyTokens: base.weekly_enabled ? weeklyConfigured : null,
    weeklyConfigured,
    weeklyEnabled: base.weekly_enabled,
    weekStartDay: base.week_start_day,
    cautionPct: base.caution_pct,
    nearPct: base.near_pct,
    activeSessionWindowMinutes: base.active_session_window_minutes,
    sessionProviderOverride: Boolean(override?.session_tokens),
    hourlyProviderOverride: Boolean(override?.hourly_tokens),
    weeklyProviderOverride: Boolean(override?.weekly_tokens),
    providerOverride: Boolean(override?.session_tokens || override?.hourly_tokens || override?.weekly_tokens),
  };
}

export function sessionLimitSummary(session, limits) {
  const used = billableTokens(session);
  const status = limitStatus(used, limits?.sessionTokens || null, limits);
  return { used, status, pct: progressPct(status) };
}

export function weeklyLimitSummary(currentWeek, limits) {
  const used = billableTokens(currentWeek);
  const status = limitStatus(used, limits?.weeklyTokens || null, limits);
  const remaining = limits?.weeklyTokens == null ? null : Math.max(0, limits.weeklyTokens - used);
  return { used, status, pct: progressPct(status), remaining };
}

export function hourlyLimitSummary(currentHour, limits) {
  const used = billableTokens(currentHour);
  const status = limitStatus(used, limits?.hourlyTokens || null, limits);
  const remaining = limits?.hourlyTokens == null ? null : Math.max(0, limits.hourlyTokens - used);
  return { used, status, pct: progressPct(status), remaining };
}

export function warningLabel(status, remainingTokens, noun = 'Weekly') {
  if (!status || status.pct == null) return '';
  if (status.cls === 'exceeded') return `${noun} limit exceeded. New usage will count beyond your configured dashboard threshold until reset.`;
  if (status.cls === 'near') return `${remainingTokens ?? 0} tokens remain before this ${noun.toLowerCase()} limit is reached.`;
  if (status.cls === 'caution') return `${noun} usage is climbing. Keep an eye on large prompts, tool results, and long sessions.`;
  return '';
}

export function normalizeUsageSettings(raw = {}) {
  const caution = clampInt(raw.caution_pct, 75, 1, 99);
  let near = clampInt(raw.near_pct, 90, 1, 99);
  let safeCaution = caution;
  if (near <= safeCaution) {
    near = Math.min(99, safeCaution + 1);
    if (near <= safeCaution) safeCaution = Math.max(1, near - 1);
  }
  const providers = raw.providers || {};
  return {
    session_tokens: positiveInt(raw.session_tokens),
    hourly_tokens: positiveInt(raw.hourly_tokens),
    weekly_tokens: positiveInt(raw.weekly_tokens),
    weekly_enabled: raw.weekly_enabled !== false,
    week_start_day: clampInt(raw.week_start_day, 1, 0, 6),
    caution_pct: safeCaution,
    near_pct: near,
    active_session_window_minutes: clampInt(raw.active_session_window_minutes, 20, 1, 1440),
    providers: {
      claude: normalizeProviderSettings(providers.claude),
      codex: normalizeProviderSettings(providers.codex),
    },
  };
}

export async function loadUsageSettings(apiFn = path => fetch(path).then(r => r.json())) {
  const settings = normalizeUsageSettings(await apiFn('/api/settings/usage-limits'));
  if (typeof localStorage !== 'undefined' && localStorage.getItem('td.usage-limits-migrated') !== '1') {
    const migrated = settingsFromLocalStorage(settings);
    await fetch('/api/settings/usage-limits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(migrated),
    });
    localStorage.setItem('td.usage-limits-migrated', '1');
    return normalizeUsageSettings(migrated);
  }
  return settings;
}

export function settingsFromLocalStorage(base = {}) {
  const settings = normalizeUsageSettings(base);
  const session = readPositiveNumber('td.session-limit-tokens');
  const weekly = readPositiveNumber('td.weekly-limit-tokens');
  const caution = readThreshold('td.weekly-caution-pct', settings.caution_pct);
  const near = readThreshold('td.weekly-near-pct', settings.near_pct);
  return normalizeUsageSettings({
    ...settings,
    session_tokens: session || settings.session_tokens,
    weekly_tokens: weekly || settings.weekly_tokens,
    weekly_enabled: localStorage.getItem('td.weekly-limit-enabled') !== '0',
    week_start_day: readWeekStartDay(settings.week_start_day),
    caution_pct: caution,
    near_pct: near,
  });
}

function normalizeProviderSettings(raw = {}) {
  return {
    session_tokens: positiveInt(raw.session_tokens),
    hourly_tokens: positiveInt(raw.hourly_tokens),
    weekly_tokens: positiveInt(raw.weekly_tokens),
  };
}

function positiveInt(value) {
  if (value == null || value === '') return null;
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function clampInt(value, fallback, min, max) {
  const parsed = Math.round(Number(value));
  const n = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, n));
}

function readPositiveNumber(key) {
  if (typeof localStorage === 'undefined') return null;
  return positiveInt(localStorage.getItem(key));
}

function readThreshold(key, fallback) {
  if (typeof localStorage === 'undefined') return fallback;
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value >= 1 && value <= 99 ? value : fallback;
}

function readWeekStartDay(fallback) {
  if (typeof localStorage === 'undefined') return fallback;
  const raw = localStorage.getItem('td.week-start-day');
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : fallback;
}
