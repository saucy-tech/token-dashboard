# MVP PRD

## Product

Agent Dashboard is a local-first usage dashboard for AI coding tools. The MVP tracks Claude Code and Codex out of the box, with Warp planned as an optional add-on once a reliable local usage source is available.

## Problem

Power users bounce between multiple coding assistants, but their usage history is fragmented across hidden local files, session logs, and vendor-specific views. That makes it hard to answer simple questions:

- Which tool am I actually using most?
- Which projects are consuming the most tokens?
- Which prompts or workflows are unexpectedly expensive?
- Am I getting value from my current usage patterns?

## Goals

- Show a single local dashboard for Claude and Codex usage.
- Preserve privacy by reading only local machine data.
- Make provider, project, prompt, session, and tool usage easy to compare.
- Stay dependency-light and easy to run.

## Non-goals

- Cloud sync or hosted telemetry.
- Billing-grade accuracy for tools that do not expose full local token data.
- Full vendor parity across every tab on day one.
- Real-time desktop integrations beyond local file polling.

## MVP Scope

- Scan Claude Code sessions from `~/.claude/projects`.
- Scan Codex active and archived sessions from `~/.codex/sessions` and `~/.codex/archived_sessions`.
- Normalize both sources into one SQLite cache.
- Show combined overview metrics plus provider-specific summaries.
- Support prompts, sessions, projects, tools, tips, and settings views with mixed-provider data.
- Show Codex session labels when available.
- Mark cost as partial when pricing is missing for some models.

## Warp Add-on Scope

- Treat Warp as an optional integration, not a blocker for MVP.
- Do not ship per-session Warp analytics until there is a reliable local source for prompt, model, and usage data.
- Keep the ingest layer extensible so Warp can be added as a new provider without rewriting the UI or schema.

## User Stories

- As a solo developer, I want one dashboard for Claude and Codex so I can compare usage without switching apps.
- As a heavy user, I want to see which projects and sessions are consuming the most tokens.
- As a cost-conscious user, I want partial-cost warnings when model pricing is unknown instead of misleading totals.
- As a privacy-conscious user, I want all processing to stay on my machine.

## Success Criteria

- A fresh install can scan both Claude and Codex local histories with one command.
- The dashboard clearly separates provider usage in the overview and session views.
- The test suite passes.
- Real local data produces sane provider totals and recent-session output.

## Suggested Improvements

- Add first-class filters for provider, project, model, and date range across every tab.
- Add export options for CSV/JSON summaries.
- Add weekly rollups and trend deltas on the overview page.
- Add known pricing for Codex models and partial-pricing breakdowns per provider.
- Add a dedicated provider comparison page.
- Add a Warp adapter based on a stable local usage artifact or export flow.
- Add background snapshotting of daily totals so long-term trends do not depend on rescanning raw logs every time.
