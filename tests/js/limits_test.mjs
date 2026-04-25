import assert from 'node:assert/strict';
import {
  billableTokens,
  currentWeekWindow,
  hourlyLimitSummary,
  limitForProvider,
  limitStatus,
  progressPct,
  sessionLimitSummary,
  weeklyLimitSummary,
} from '../../web/limits.js';

assert.equal(billableTokens(null), 0);
assert.equal(billableTokens({ input_tokens: 10, output_tokens: 20, cache_create_5m_tokens: 3, cache_create_1h_tokens: 7 }), 40);
assert.equal(billableTokens({ billable_tokens: 123, input_tokens: 999 }), 123);

let status = limitStatus(0, 100, { cautionPct: 75, nearPct: 90 });
assert.equal(status.cls, 'normal');
assert.equal(status.label, '0% used');
assert.equal(progressPct(status), 0);

status = limitStatus(74, 100, { cautionPct: 75, nearPct: 90 });
assert.equal(status.cls, 'normal');

status = limitStatus(75, 100, { cautionPct: 75, nearPct: 90 });
assert.equal(status.cls, 'caution');

status = limitStatus(90, 100, { cautionPct: 75, nearPct: 90 });
assert.equal(status.cls, 'near');

status = limitStatus(125, 100, { cautionPct: 75, nearPct: 90 });
assert.equal(status.cls, 'exceeded');
assert.equal(progressPct(status), 100);

status = limitStatus(80, 100, { cautionPct: 60, nearPct: 85 });
assert.equal(status.cls, 'caution');

status = limitStatus(86, 100, { cautionPct: 60, nearPct: 85 });
assert.equal(status.cls, 'near');

status = limitStatus(50, null);
assert.equal(status.cls, 'unset');
assert.equal(progressPct(status), 0);

let window = currentWeekWindow(new Date('2026-04-20T00:00:00'), 1);
assert.equal(window.start.getFullYear(), 2026);
assert.equal(window.start.getMonth(), 3);
assert.equal(window.start.getDate(), 20);
assert.equal(window.start.getHours(), 0);
assert.equal(window.reset.getDate(), 27);

window = currentWeekWindow(new Date('2026-04-19T23:59:59'), 1);
assert.equal(window.start.getDate(), 13);
assert.equal(window.reset.getDate(), 20);

window = currentWeekWindow(new Date('2026-04-19T12:00:00'), 0);
assert.equal(window.start.getDate(), 19);
assert.equal(window.reset.getDate(), 26);

window = currentWeekWindow(new Date('2026-04-22T12:00:00'), 99);
assert.equal(window.weekStartDay, 1);

window = currentWeekWindow(new Date('2026-04-22T12:00:00'), null);
assert.equal(window.weekStartDay, 1);

const settings = {
  session_tokens: 1000,
  hourly_tokens: 4000,
  weekly_tokens: 10000,
  weekly_enabled: true,
  caution_pct: 70,
  near_pct: 90,
  providers: {
    claude: { session_tokens: 2000, hourly_tokens: 8000, weekly_tokens: 20000 },
    codex: { session_tokens: null, hourly_tokens: 3000, weekly_tokens: 5000 },
  },
};

let limits = limitForProvider(settings, 'all');
assert.equal(limits.sessionTokens, 1000);
assert.equal(limits.hourlyTokens, 4000);
assert.equal(limits.weeklyTokens, 10000);
assert.equal(limits.providerOverride, false);

limits = limitForProvider(settings, 'claude');
assert.equal(limits.sessionTokens, 2000);
assert.equal(limits.hourlyTokens, 8000);
assert.equal(limits.weeklyTokens, 20000);
assert.equal(limits.providerOverride, true);
assert.equal(limits.sessionProviderOverride, true);

limits = limitForProvider(settings, 'codex');
assert.equal(limits.sessionTokens, 1000);
assert.equal(limits.hourlyTokens, 3000);
assert.equal(limits.weeklyTokens, 5000);
assert.equal(limits.providerOverride, true);
assert.equal(limits.sessionProviderOverride, false);

const session = sessionLimitSummary({ billable_tokens: 950 }, limits);
assert.equal(session.status.cls, 'near');
assert.equal(session.pct, 95);

const week = weeklyLimitSummary({ input_tokens: 1000, output_tokens: 1500, cache_create_5m_tokens: 500 }, limits);
assert.equal(week.used, 3000);
assert.equal(week.remaining, 2000);
assert.equal(week.status.cls, 'normal');

const hour = hourlyLimitSummary({ input_tokens: 2600, output_tokens: 200, cache_create_5m_tokens: 200 }, limits);
assert.equal(hour.used, 3000);
assert.equal(hour.remaining, 0);
assert.equal(hour.status.cls, 'exceeded');
