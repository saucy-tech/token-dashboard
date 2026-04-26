# Known Limitations

None of these are blockers — the dashboard still gives you useful information. They're the rough edges you'll notice if you look hard.

## Skills token counts are partial

The Skills route shows every skill Claude Code invoked, how many times, across how many sessions, and when. The **tokens-per-call** column is populated only for skills whose `SKILL.md` lives under `~/.claude/skills/`, `~/.claude/scheduled-tasks/`, or `~/.claude/plugins/`. Skills registered elsewhere (project-local `.claude/skills/`, or invocations that go through the `Task` tool with a skill-shaped `subagent_type`) show invocation counts but leave the token column blank.

It's still a useful view — you can see which skills dominate your session time — just don't expect a complete per-skill token cost. PRs to broaden the catalog scan welcome.

## Cost for Pro / Max / Max-20x users is shown as API-equivalent, not subscription value

The Settings route lets you select your pricing plan, but the Overview cost number is always the API-equivalent (what the same usage would have cost on pay-per-token rates). If you're on Pro you pay a flat $20/month regardless of how much of that API-equivalent number you rack up. We don't do "subscription ROI" math yet — Anthropic doesn't publish per-plan rate limits as public JSON, and faking it would be worse than not doing it.

## Cowork sessions are invisible

If you use Claude's Cowork mode (server-side sessions, not local `claude` CLI), those sessions don't write JSONL to `~/.claude/projects/` and the dashboard can't see them.

## Source status is cache-aware, not a cloud sync check

The dashboard can tell whether the configured local folders exist, whether logs are present, and whether files have been scanned into the SQLite cache. It cannot prove that a provider's cloud-side history is complete. Missing, disabled, or unscanned sources mean the dashboard is showing a partial local view.

## Usage limits are dashboard thresholds, not vendor quotas

Session and weekly limits are stored in the local SQLite database and shown against scanned local logs. They do not come from Anthropic, OpenAI, or any subscription quota API. Weekly reset uses the browser's local calendar boundary and sends that window to the backend as ISO timestamps for filtering. The "latest scanned session" can be marked active with a freshness heuristic, but the dashboard still cannot prove that a vendor app currently has an open live session.

## Non-standard model names get tier-fallback pricing

If a transcript references a model ID not in `pricing.json` (e.g. a future snapshot that isn't in our table yet), cost is estimated from known family substrings in the model name. Claude (`opus` / `sonnet` / `haiku`) and GPT/Codex name families have fallback pricing and are marked estimated. Completely unrecognized names still report null cost.

## First scan can be slow

The first `python3 cli.py scan` on a heavy user's machine can read tens of MB across hundreds of JSONLs. Subsequent scans are incremental (mtime + byte-offset tracking in the `files` table), so they're fast.

## Running two dashboards against the same DB

Both will fight over the SQLite file and you'll see inconsistent numbers and occasional `database is locked` errors. Only run one at a time. If you want to view the dashboard from a second device, use `HOST=0.0.0.0` on the one running machine and point the second device's browser at it.

## Skip reporting covers Claude JSONL only

The `scan_errors.log` and `skipped_records` counter in `/api/sources` only reflect parse errors from Claude Code transcripts (`scan_file()`). Codex session parsing (`scan_codex_home`) silently discards malformed records without contributing to the skip count. Codex parse failures will not appear in the UI warning or log.

## scan_errors.log write is non-atomic

Concurrent scans (background 30s loop + user-triggered scan) can race on `scan_errors.log`. A `/api/sources` read mid-write may return zero skipped records due to the `try/except` catching a partial-line JSON error. For a single-user local tool this is cosmetic — the next `/api/sources` call will see the correct data.
