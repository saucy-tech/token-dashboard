import assert from 'node:assert/strict';
import { billableTokens, currentWeekWindow, limitStatus, progressPct } from '../../web/limits.js';

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
