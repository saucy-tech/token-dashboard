// web/provider-plans.js — per-provider plan definitions with enforced rate limits
// Source: Anthropic/OpenAI published limits + CodexBar's observed windows.
// These are the PROVIDER-ENFORCED limits (not user-set thresholds).
// Values are approximate — providers adjust them without notice.
// Last verified: April 2026.

export const CLAUDE_PLANS = [
  {
    key: 'claude-free',
    label: 'Claude.ai Free',
    monthly: 0,
    // Anthropic Free: very limited, context-dependent
    session_tokens:  20000,
    hourly_tokens:   40000,
    weekly_tokens:   200000,
    note: 'Free tier limits are low and context-dependent.',
  },
  {
    key: 'claude-pro',
    label: 'Claude.ai Pro',
    monthly: 20,
    // Pro: ~5× usage vs Free; Claude Code gets ~100K context window
    session_tokens:  100000,
    hourly_tokens:   500000,
    weekly_tokens:   3000000,
    note: 'Pro limits reset weekly. Heavy tool-call sessions may hit session limits sooner.',
  },
  {
    key: 'claude-max5',
    label: 'Claude.ai Max 5×',
    monthly: 100,
    // Max 5×: 5× Pro usage; same context window
    session_tokens:  200000,
    hourly_tokens:   2000000,
    weekly_tokens:   15000000,
    note: 'Max 5× provides 5× the usage of Pro per billing period.',
  },
  {
    key: 'claude-max20',
    label: 'Claude.ai Max 20×',
    monthly: 200,
    // Max 20×: 20× Pro usage
    session_tokens:  200000,
    hourly_tokens:   4000000,
    weekly_tokens:   60000000,
    note: 'Max 20× provides 20× the usage of Pro per billing period.',
  },
  {
    key: 'claude-api',
    label: 'Anthropic API (pay-as-you-go)',
    monthly: null,
    // API: no hard token limits, only rate limits per tier
    session_tokens:  null,
    hourly_tokens:   null,
    weekly_tokens:   null,
    note: 'API usage is metered; no dashboard-side token cap. Set your own thresholds.',
  },
];

export const CODEX_PLANS = [
  {
    key: 'codex-free',
    label: 'ChatGPT Free',
    monthly: 0,
    session_tokens:  8000,
    hourly_tokens:   32000,
    weekly_tokens:   200000,
    note: 'Free tier has strict message and token limits.',
  },
  {
    key: 'codex-plus',
    label: 'ChatGPT Plus',
    monthly: 20,
    // Plus: moderate limits; GPT-4o available
    session_tokens:  32000,
    hourly_tokens:   300000,
    weekly_tokens:   2000000,
    note: 'Plus limits reset monthly. Codex CLI usage draws from the same pool.',
  },
  {
    key: 'codex-pro',
    label: 'ChatGPT Pro',
    monthly: 200,
    // Pro: unlimited GPT-4o (within reason) + o1 access
    session_tokens:  128000,
    hourly_tokens:   2000000,
    weekly_tokens:   null,    // Pro has no hard weekly cap
    note: 'Pro has no hard weekly limit but OpenAI may throttle sustained heavy use.',
  },
  {
    key: 'codex-api',
    label: 'OpenAI API (pay-as-you-go)',
    monthly: null,
    session_tokens:  null,
    hourly_tokens:   null,
    weekly_tokens:   null,
    note: 'API usage is metered; limits depend on your tier and org settings.',
  },
];

/**
 * Return the merged effective limits for a given Claude + Codex plan combo.
 * When both providers are in use, take the more restrictive limit for safety.
 */
export function effectiveLimits(claudePlanKey, codexPlanKey) {
  const c = CLAUDE_PLANS.find(p => p.key === claudePlanKey) || CLAUDE_PLANS.find(p => p.key === 'claude-api');
  const x = CODEX_PLANS.find(p => p.key === codexPlanKey)  || CODEX_PLANS.find(p => p.key === 'codex-api');

  function minNonNull(a, b) {
    if (a == null && b == null) return null;
    if (a == null) return b;
    if (b == null) return a;
    return Math.min(a, b);
  }

  return {
    claude: {
      session_tokens: c.session_tokens,
      hourly_tokens:  c.hourly_tokens,
      weekly_tokens:  c.weekly_tokens,
    },
    codex: {
      session_tokens: x.session_tokens,
      hourly_tokens:  x.hourly_tokens,
      weekly_tokens:  x.weekly_tokens,
    },
    // "all providers" view uses the more conservative of the two
    combined: {
      session_tokens: minNonNull(c.session_tokens, x.session_tokens),
      hourly_tokens:  minNonNull(c.hourly_tokens,  x.hourly_tokens),
      weekly_tokens:  minNonNull(c.weekly_tokens,   x.weekly_tokens),
    },
  };
}

/** Render a <select> for Claude plan or Codex plan. */
export function planSelectHtml(plans, selectedKey, id) {
  return `<select id="${id}" style="width:100%">
    ${plans.map(p => `
      <option value="${p.key}" ${p.key === selectedKey ? 'selected' : ''}>
        ${p.label}${p.monthly != null ? ` — $${p.monthly}/mo` : ''}
      </option>`).join('')}
  </select>`;
}

/** Summary row showing what limits a plan provides. */
export function planLimitsPreviewHtml(plan) {
  function row(label, val) {
    return `<div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--muted);padding:2px 0;">
      <span>${label}</span>
      <span style="color:var(--text);">${val != null ? Number(val).toLocaleString() + ' tok' : 'no cap'}</span>
    </div>`;
  }
  return `
    <div style="margin-top:8px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--muted);margin-bottom:6px;">
        Enforced limits for this plan
      </div>
      ${row('Per session', plan.session_tokens)}
      ${row('Per hour',    plan.hourly_tokens)}
      ${row('Per week',    plan.weekly_tokens)}
      ${plan.note ? `<div style="margin-top:6px;font-size:11px;color:var(--muted-2);line-height:1.4;">${plan.note}</div>` : ''}
    </div>`;
}
