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
