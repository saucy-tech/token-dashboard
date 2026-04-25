const KEY = 'td.pace-history-v1';
const MAX_ENTRIES = 120;

function readAll() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(rows) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY, JSON.stringify(rows.slice(-MAX_ENTRIES)));
}

export function paceHistory(providerKey, weekStartIso) {
  const provider = providerKey || 'all';
  return readAll()
    .filter(row => row && row.provider === provider && row.weekStartIso === weekStartIso)
    .slice(-14);
}

export function recordPacePoint({ providerKey = 'all', weekStartIso, pct, ts = Date.now() }) {
  if (!weekStartIso || !Number.isFinite(pct)) return paceHistory(providerKey, weekStartIso);
  const provider = providerKey || 'all';
  const rows = readAll();
  const roundedPct = Math.max(0, Math.min(100, Math.round(pct)));
  const existingIndex = rows.findIndex(row =>
    row && row.provider === provider && row.weekStartIso === weekStartIso && row.ts === ts
  );
  if (existingIndex >= 0) {
    rows[existingIndex] = { ...rows[existingIndex], pct: roundedPct };
  } else {
    rows.push({ provider, weekStartIso, pct: roundedPct, ts });
  }
  writeAll(rows);
  return paceHistory(provider, weekStartIso);
}
