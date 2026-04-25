import { api, fmt, providerTabs, readProvider, withQuery, writeHashParams } from '/web/app.js';
import {
  currentWeekWindow,
  hourlyLimitSummary,
  limitForProvider,
  loadUsageSettings,
  progressPct,
  rollingHourWindow,
  sessionLimitSummary,
  warningLabel,
  weeklyLimitSummary,
} from '/web/limits.js';
import { paceHistory, recordPacePoint } from '/web/pace-history.js';

function statusClass(status) {
  if (!status || status.pct == null) return 'normal';
  if (status.cls === 'exceeded') return 'exceeded';
  if (status.cls === 'near') return 'near';
  if (status.cls === 'caution') return 'caution';
  return 'normal';
}

function rowCard(label, used, limit, status, meta, sub) {
  const cls = statusClass(status);
  const meterPct = progressPct(status);
  const usedLabel = fmt.int(used);
  const limitLabel = limit ? fmt.int(limit) : 'not set';
  return `
    <div class="limit-progress-row ${cls}">
      <div class="limit-progress-main">
        <div>
          <div class="limit-label">${label}<span class="limit-state">${status?.name || 'Normal'}</span></div>
          <div class="limit-value">${usedLabel} / ${limitLabel}</div>
        </div>
        <div class="limit-meta">${fmt.htmlSafe(meta || '')}</div>
      </div>
      <div class="limit-meter"><span style="width:${meterPct}%"></span></div>
      <div class="limit-sub">${fmt.htmlSafe(sub || '')}</div>
    </div>`;
}

function paceLabel(now, resetAt) {
  const total = Math.max(1, resetAt.getTime() - now.getTime());
  const elapsed = Math.max(0, now.getTime() - (resetAt.getTime() - 7 * 86400000));
  const expectedPct = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
  return expectedPct;
}

function historyBars(points = []) {
  if (!points.length) return '<div class="muted" style="font-size:11px;margin-top:8px">No pace history yet.</div>';
  const max = Math.max(100, ...points.map(p => p.pct || 0));
  return `
    <div class="util-history-wrap">
      ${points.map((point, i) => {
        const pct = Number.isFinite(point.pct) ? Math.max(0, Math.min(100, point.pct)) : 0;
        const h = Math.max(3, Math.round((pct / max) * 100));
        const cls = i === points.length - 1 ? 'current' : '';
        return `
          <div class="util-history-bar ${cls}" title="${pct}%">
            <div class="util-history-track">
              <div class="util-history-fill" style="height:${h}%;background:${pct >= 100 ? 'var(--bad)' : pct >= 90 ? 'var(--warn)' : 'var(--good)'};"></div>
            </div>
            <div class="util-history-label">${pct}%</div>
          </div>`;
      }).join('')}
    </div>`;
}

export default async function (root) {
  const provider = readProvider();
  const usageSettings = await loadUsageSettings(api);
  const limits = limitForProvider(usageSettings, provider.key);
  const now = new Date();
  const hourWindow = rollingHourWindow(now);
  const weekWindow = currentWeekWindow(now, limits.weekStartDay);
  const queryProvider = provider.key === 'all' ? null : provider.key;
  const [currentSession, currentHour, currentWeek] = await Promise.all([
    api(withQuery('/api/current-session', { provider: queryProvider })),
    api(withQuery('/api/overview', {
      since: hourWindow.start.toISOString(),
      until: hourWindow.end.toISOString(),
      provider: queryProvider,
    })),
    api(withQuery('/api/overview', {
      since: weekWindow.start.toISOString(),
      until: weekWindow.reset.toISOString(),
      provider: queryProvider,
    })),
  ]);

  const sessionSummary = sessionLimitSummary(currentSession.session || null, limits);
  const hourSummary = hourlyLimitSummary(currentHour, limits);
  const weekSummary = weeklyLimitSummary(currentWeek, limits);
  const weeklyExpected = paceLabel(now, weekWindow.reset);
  const paceDelta = weekSummary.pct - weeklyExpected;
  const paceTone = weekSummary.pct > 100 ? 'pace-over' : paceDelta > 8 ? 'pace-over' : paceDelta > 0 ? 'pace-behind' : 'pace-ahead';
  const paceText = weekSummary.status.pct == null
    ? 'Set a weekly limit in Settings to enable pace tracking.'
    : `${paceDelta >= 0 ? '+' : ''}${paceDelta}% vs expected weekly pace (${weeklyExpected}% by now)`;
  const weekStartIso = weekWindow.start.toISOString().slice(0, 10);
  const points = recordPacePoint({
    providerKey: provider.key,
    weekStartIso,
    pct: weekSummary.pct,
    ts: Math.floor(Date.now() / (60 * 60 * 1000)) * (60 * 60 * 1000),
  });
  const history = points.length ? points : paceHistory(provider.key, weekStartIso);

  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px;align-items:center;gap:10px;flex-wrap:wrap;">
      <h2 style="margin:0;font-size:16px;letter-spacing:-.01em;">Limits</h2>
      <span class="muted" style="font-size:12px;">Dashboard-local tracking, not provider quota APIs</span>
      <div class="spacer"></div>
      ${providerTabs(provider.key)}
    </div>

    <div class="card limit-card-full">
      <div class="limit-panel">
        ${rowCard(
          'Current session',
          sessionSummary.used,
          limits.sessionTokens,
          sessionSummary.status,
          currentSession.freshness?.active ? 'active now' : 'latest scanned session',
          warningLabel(sessionSummary.status, limits.sessionTokens == null ? null : Math.max(0, limits.sessionTokens - sessionSummary.used), 'Session')
        )}
        ${rowCard(
          'Rolling hour',
          hourSummary.used,
          limits.hourlyTokens,
          hourSummary.status,
          `${hourWindow.start.toLocaleTimeString()} → ${hourWindow.end.toLocaleTimeString()}`,
          warningLabel(hourSummary.status, hourSummary.remaining, 'Hourly')
        )}
        ${rowCard(
          'Current week',
          weekSummary.used,
          limits.weeklyTokens,
          weekSummary.status,
          `resets ${weekWindow.reset.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
          warningLabel(weekSummary.status, weekSummary.remaining, 'Weekly')
        )}
      </div>

      <div class="limit-metrics">
        <div class="limit-metric ${statusClass(sessionSummary.status)}">
          <div class="label">Session utilization</div>
          <div class="value">${sessionSummary.status?.label || 'not set'}</div>
        </div>
        <div class="limit-metric ${statusClass(hourSummary.status)}">
          <div class="label">Hourly utilization</div>
          <div class="value">${hourSummary.status?.label || 'not set'}</div>
        </div>
        <div class="limit-metric ${statusClass(weekSummary.status)}">
          <div class="label">Weekly utilization</div>
          <div class="value">${weekSummary.status?.label || 'not set'}</div>
        </div>
        <div class="limit-metric">
          <div class="label">Provider override</div>
          <div class="value">${limits.providerOverride ? 'enabled' : 'global defaults'}</div>
        </div>
      </div>

      <div style="margin-top:14px;">
        <div class="flex" style="align-items:center;gap:10px;">
          <strong style="font-size:12px;">Weekly pace</strong>
          <span class="muted" style="font-size:11px;">Expected pace assumes linear use through reset.</span>
          <span class="spacer"></span>
          <a href="#/settings">Adjust limits →</a>
        </div>
        <div class="pace-bar-wrap" style="margin-top:8px;">
          <div class="pace-bar-fill-outer">
            <div class="pace-bar-fill-inner" style="width:${weekSummary.pct}%;background:${weekSummary.pct >= 100 ? 'var(--bad)' : weekSummary.pct >= 90 ? 'var(--warn)' : 'var(--good)'};"></div>
          </div>
          <div class="pace-bar-tick" style="left:${weeklyExpected}%;"></div>
        </div>
        <div class="${paceTone}" style="font-size:12px;font-family:var(--mono);">${fmt.htmlSafe(paceText)}</div>
        ${historyBars(history)}
      </div>
    </div>
  `;

  root.querySelectorAll('.provider-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      writeHashParams({ provider: btn.dataset.provider === 'all' ? null : btn.dataset.provider });
    });
  });
}
