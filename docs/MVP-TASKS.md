# MVP Tasks

This is the working execution list for the Agent Dashboard MVP. The goal is to keep shipping in small slices, not just brainstorm them.

## Done

- [x] Clone and baseline the original `token-dashboard` project.
- [x] Get local scanning working against Claude project transcripts.
- [x] Add Codex session ingestion from local `~/.codex` logs.
- [x] Store provider-aware rows in SQLite for messages and tool calls.
- [x] Rebrand the UI to "Agent Dashboard".
- [x] Add provider badges and provider summary cards to the dashboard.
- [x] Flag estimated cost as partial when pricing data is missing.
- [x] Draft the MVP product direction in [MVP-PRD.md](/Users/brandon/Developer/token-dashboard/docs/MVP-PRD.md).
- [x] Add provider filtering to Overview, Prompts, Sessions, and Projects.
- [x] Add CSV and JSON export for prompts, sessions, and project summaries.
- [x] Add a dedicated provider comparison view with Claude vs. Codex deltas over time.

## Next

- [ ] Fill in Codex pricing mappings so estimated cost is less partial.
- [ ] Add session drill-down improvements such as copied prompt text and tool-call detail.
- [ ] Add a lightweight onboarding state that detects missing local data sources and explains what is connected.

## Blocked Or Research

- [ ] Warp ingestion is still blocked on finding a reliable local per-session usage artifact on this machine.
- [ ] Warp should stay an optional add-on until that source is confirmed and repeatable.

## Definition Of A Useful MVP

- [x] See total sessions, turns, tokens, cache usage, and estimated cost.
- [x] Compare Claude and Codex in one dashboard.
- [x] Inspect recent sessions and expensive prompts.
- [x] Slice the main views by provider.
- [x] Export the data for reuse outside the app.
- [ ] Add Warp once the local source is dependable.
