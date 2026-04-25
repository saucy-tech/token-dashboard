"""SQLite schema, connection, and shared query helpers."""
from __future__ import annotations

import os
import re
import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Union

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  mtime       REAL    NOT NULL,
  bytes_read  INTEGER NOT NULL,
  scanned_at  REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  uuid                    TEXT PRIMARY KEY,
  parent_uuid             TEXT,
  session_id              TEXT NOT NULL,
  project_slug            TEXT NOT NULL,
  provider                TEXT NOT NULL DEFAULT 'claude',
  session_label           TEXT,
  cwd                     TEXT,
  git_branch              TEXT,
  cc_version              TEXT,
  entrypoint              TEXT,
  type                    TEXT NOT NULL,
  is_sidechain            INTEGER NOT NULL DEFAULT 0,
  agent_id                TEXT,
  timestamp               TEXT NOT NULL,
  model                   TEXT,
  stop_reason             TEXT,
  prompt_id               TEXT,
  message_id              TEXT,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_create_5m_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_create_1h_tokens  INTEGER NOT NULL DEFAULT 0,
  prompt_text             TEXT,
  prompt_chars            INTEGER,
  tool_calls_json         TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_project   ON messages(project_slug);
CREATE INDEX IF NOT EXISTS idx_messages_provider  ON messages(provider);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_model     ON messages(model);
CREATE INDEX IF NOT EXISTS idx_messages_msgid     ON messages(session_id, message_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uuid  TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  project_slug  TEXT    NOT NULL,
  provider      TEXT    NOT NULL DEFAULT 'claude',
  tool_name     TEXT    NOT NULL,
  target        TEXT,
  result_tokens INTEGER,
  is_error      INTEGER NOT NULL DEFAULT 0,
  timestamp     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tools_name    ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_target  ON tool_calls(target);
CREATE INDEX IF NOT EXISTS idx_tools_provider ON tool_calls(provider);

CREATE TABLE IF NOT EXISTS plan (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS dismissed_tips (
  tip_key       TEXT PRIMARY KEY,
  dismissed_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  period                  TEXT NOT NULL,
  start_date              TEXT NOT NULL,
  end_date                TEXT NOT NULL,
  provider                TEXT NOT NULL,
  dimension               TEXT NOT NULL,
  dimension_key           TEXT NOT NULL,
  dimension_label         TEXT NOT NULL,
  sessions                INTEGER NOT NULL DEFAULT 0,
  turns                   INTEGER NOT NULL DEFAULT 0,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_create_5m_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_create_1h_tokens  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period, start_date, provider, dimension, dimension_key)
);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_scope
  ON usage_snapshots(period, provider, dimension, start_date);

CREATE TABLE IF NOT EXISTS usage_snapshot_meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS session_rollups (
  session_id              TEXT PRIMARY KEY,
  provider                TEXT NOT NULL,
  session_label           TEXT,
  project_slug            TEXT NOT NULL,
  project_name            TEXT,
  cwd                     TEXT,
  started_at              TEXT NOT NULL,
  ended_at                TEXT NOT NULL,
  computed_at             REAL NOT NULL,
  is_current              INTEGER NOT NULL DEFAULT 0,
  turns                   INTEGER NOT NULL DEFAULT 0,
  records                 INTEGER NOT NULL DEFAULT 0,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_create_5m_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_create_1h_tokens  INTEGER NOT NULL DEFAULT 0,
  billable_tokens         INTEGER NOT NULL DEFAULT 0,
  primary_model           TEXT,
  model_count             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_rollups_provider_current
  ON session_rollups(provider, is_current, ended_at);
CREATE INDEX IF NOT EXISTS idx_session_rollups_ended
  ON session_rollups(ended_at);
"""


def default_db_path() -> Path:
    return Path.home() / ".claude" / "token-dashboard.db"


def init_db(path: Union[str, Path]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as c:
        c.executescript(SCHEMA)
        _migrate_create_settings(c)
        _migrate_add_message_id(c)
        _migrate_add_messages_provider(c)
        _migrate_add_messages_session_label(c)
        _migrate_add_tool_calls_provider(c)
        c.commit()


def _migrate_create_settings(conn) -> None:
    conn.execute("""
      CREATE TABLE IF NOT EXISTS settings (
        k TEXT PRIMARY KEY,
        v TEXT
      )
    """)


def _migrate_add_message_id(conn) -> None:
    """Add messages.message_id for streaming-snapshot dedup.

    Why: pre-migration rows were summed from all streaming snapshots (over-count).
    How to apply: if the old table exists without the column, add it and clear
    messages/tool_calls/files so the next scan replays JSONLs cleanly. Source
    of truth is on disk; rescanning is cheap.
    """
    has_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'"
    ).fetchone()
    if not has_table:
        return
    cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
    if "message_id" in cols:
        return
    conn.execute("ALTER TABLE messages ADD COLUMN message_id TEXT")
    conn.execute("DELETE FROM messages")
    conn.execute("DELETE FROM tool_calls")
    conn.execute("DELETE FROM files")
    conn.commit()


def _migrate_add_messages_provider(conn) -> None:
    has_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'"
    ).fetchone()
    if not has_table:
        return
    cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
    if "provider" not in cols:
        conn.execute("ALTER TABLE messages ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'")
    conn.execute("UPDATE messages SET provider='claude' WHERE provider IS NULL OR provider=''")


def _migrate_add_messages_session_label(conn) -> None:
    has_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'"
    ).fetchone()
    if not has_table:
        return
    cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
    if "session_label" not in cols:
        conn.execute("ALTER TABLE messages ADD COLUMN session_label TEXT")


def _migrate_add_tool_calls_provider(conn) -> None:
    has_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_calls'"
    ).fetchone()
    if not has_table:
        return
    cols = {row[1] for row in conn.execute("PRAGMA table_info(tool_calls)")}
    if "provider" not in cols:
        conn.execute("ALTER TABLE tool_calls ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'")
    conn.execute("UPDATE tool_calls SET provider='claude' WHERE provider IS NULL OR provider=''")


@contextmanager
def connect(path: Union[str, Path]):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def _range_clause(since, until, col: str = "timestamp"):
    where, args = [], []
    if since:
        where.append(f"{col} >= ?"); args.append(since)
    if until:
        where.append(f"{col} < ?"); args.append(until)
    return ((" AND " + " AND ".join(where)) if where else "", args)


def _normalize_provider(provider: Optional[str]) -> Optional[str]:
    if provider is None:
        return None
    normalized = str(provider).strip().lower()
    if not normalized or normalized == "all":
        return None
    return normalized


def _provider_clause(provider: Optional[str], col: str = "provider"):
    normalized = _normalize_provider(provider)
    if not normalized:
        return "", []
    return f" AND COALESCE({col}, 'claude') = ?", [normalized]


def _encode_slug(path: str) -> str:
    """Claude Code's project-slug encoding: each of `:`, `\\`, `/`, space → one `-`."""
    return re.sub(r"[:\\/ ]", "-", path)


def _walk_to_root(cwd: str, slug: str) -> Optional[str]:
    """If any ancestor of cwd encodes to slug, return that ancestor's basename."""
    if not cwd or not slug:
        return None
    trimmed = cwd.rstrip("/\\")
    sep = "\\" if "\\" in trimmed else "/"
    parts = trimmed.split(sep)
    for i in range(len(parts), 0, -1):
        if _encode_slug(sep.join(parts[:i])) == slug:
            name = parts[i - 1]
            if name:
                return name
    return None


def project_name_for(cwd: Optional[str], fallback_slug: str) -> str:
    """Pretty project name from a single cwd + slug (best-effort).

    For the multi-cwd case, prefer `best_project_name`.
    """
    name = _walk_to_root(cwd or "", fallback_slug or "")
    if name:
        return name
    if cwd:
        trimmed = cwd.rstrip("/\\")
        sep = "\\" if "\\" in trimmed else "/"
        tail = trimmed.split(sep)[-1]
        if tail:
            return tail
    if fallback_slug:
        parts = [p for p in re.split(r"-+", fallback_slug) if p]
        if parts:
            return parts[-1]
    return fallback_slug or ""


def best_project_name(cwds, slug: str) -> str:
    """Pick a pretty name from a list of cwds.

    Prefer a cwd whose walk-up matches `slug` (a true descendant of the project
    root). If none match, fall back to `project_name_for` on the first cwd,
    then to the slug's last segment.
    """
    cwds = [c for c in (cwds or []) if c]
    for cwd in cwds:
        name = _walk_to_root(cwd, slug)
        if name:
            return name
    return project_name_for(cwds[0] if cwds else None, slug)


def overview_totals(db_path, since=None, until=None, provider: Optional[str] = None) -> dict:
    rng, args = _range_clause(since, until)
    prov, prov_args = _provider_clause(provider)
    sql = f"""
      SELECT COUNT(DISTINCT session_id) AS sessions,
             SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns,
             COALESCE(SUM(input_tokens),0)            AS input_tokens,
             COALESCE(SUM(output_tokens),0)           AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages WHERE 1=1 {rng}{prov}
    """
    with connect(db_path) as c:
        return dict(c.execute(sql, [*args, *prov_args]).fetchone())


def expensive_prompts(
    db_path,
    limit: int = 50,
    sort: str = "tokens",
    provider: Optional[str] = None,
    offset: int = 0,
) -> list:
    """User prompt joined with the immediately-following assistant turn's tokens.

    sort="tokens" (default) → largest billable first.
    sort="recent"           → newest first.
    """
    order = "u.timestamp DESC" if sort == "recent" else "billable_tokens DESC"
    prov, prov_args = _provider_clause(provider, col="u.provider")
    sql = f"""
      SELECT u.uuid AS user_uuid, u.session_id, u.project_slug, u.timestamp,
             COALESCE(a.provider, u.provider, 'claude') AS provider,
             COALESCE(a.session_label, u.session_label) AS session_label,
             u.prompt_text, u.prompt_chars,
             a.uuid AS assistant_uuid, a.model,
             COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0)
               +COALESCE(a.cache_create_5m_tokens,0)+COALESCE(a.cache_create_1h_tokens,0) AS billable_tokens,
             COALESCE(a.cache_read_tokens,0) AS cache_read_tokens
        FROM messages u
        JOIN messages a ON a.parent_uuid = u.uuid AND a.type='assistant'
       WHERE u.type='user' AND u.prompt_text IS NOT NULL {prov}
       ORDER BY {order}
       LIMIT ?
      OFFSET ?
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, [*prov_args, limit, offset])]
        for row in rows:
            _enrich_prompt_row(c, row)
        return rows


def recent_prompts(
    db_path,
    limit: int = 50,
    sort: str = "tokens",
    provider: Optional[str] = None,
    offset: int = 0,
) -> list:
    """Compatibility helper used by `/api/prompts`."""
    return expensive_prompts(
        db_path,
        limit=limit,
        sort=sort,
        provider=provider,
        offset=offset,
    )


def _enrich_prompt_row(conn, row: dict) -> None:
    tools = conn.execute("""
      SELECT tool_name, target, COUNT(*) AS calls,
             COALESCE(SUM(result_tokens), 0) AS result_tokens,
             MAX(COALESCE(result_tokens, 0)) AS max_result_tokens
        FROM tool_calls
       WHERE message_uuid = ?
       GROUP BY tool_name, target
       ORDER BY result_tokens DESC, calls DESC
       LIMIT 5
    """, (row["assistant_uuid"],)).fetchall()
    drivers = []
    total_tool_tokens = 0
    repeated_reads = 0
    oversized_results = 0
    for tool in tools:
        result_tokens = int(tool["result_tokens"] or 0)
        calls = int(tool["calls"] or 0)
        total_tool_tokens += result_tokens
        if tool["tool_name"] in ("Read", "Grep", "Glob", "LS") and calls > 1:
            repeated_reads += calls
        if result_tokens >= 50000 or int(tool["max_result_tokens"] or 0) >= 50000:
            oversized_results += 1
        drivers.append({
            "tool_name": tool["tool_name"],
            "target": tool["target"],
            "calls": calls,
            "result_tokens": result_tokens,
            "max_result_tokens": int(tool["max_result_tokens"] or 0),
        })
    reasons = []
    if oversized_results:
        reasons.append(f"{oversized_results} oversized tool result{'s' if oversized_results != 1 else ''}")
    if repeated_reads:
        reasons.append(f"{repeated_reads} repeated read/search calls")
    if total_tool_tokens:
        reasons.append(f"{total_tool_tokens:,} tool-result tokens")
    if not reasons and row["cache_read_tokens"]:
        reasons.append(f"{int(row['cache_read_tokens']):,} cache-read tokens")
    row["cost_drivers"] = drivers
    row["why_expensive"] = "; ".join(reasons) if reasons else "Token use came mostly from the assistant turn itself."


def project_summary(db_path, since=None, until=None, provider: Optional[str] = None) -> list:
    rng, args = _range_clause(since, until)
    prov, prov_args = _provider_clause(provider, col="m.provider")
    provider_key = _normalize_provider(provider)
    sql = f"""
      SELECT project_slug,
             COUNT(DISTINCT session_id) AS sessions,
             SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns,
             COALESCE(SUM(input_tokens), 0)  AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             SUM(input_tokens)+SUM(output_tokens)
               +SUM(cache_create_5m_tokens)+SUM(cache_create_1h_tokens) AS billable_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens
        FROM messages m
       WHERE 1=1 {rng}{prov}
       GROUP BY project_slug
       ORDER BY billable_tokens DESC
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, [*args, *prov_args])]
        for r in rows:
            cwd_sql = "SELECT DISTINCT cwd FROM messages WHERE project_slug=? AND cwd IS NOT NULL"
            cwd_args = [r["project_slug"]]
            if provider_key:
                cwd_sql += " AND COALESCE(provider, 'claude') = ?"
                cwd_args.append(provider_key)
            cwds = [row["cwd"] for row in c.execute(cwd_sql, cwd_args)]
            r["project_name"] = best_project_name(cwds, r["project_slug"])
    return rows


def tool_token_breakdown(db_path, since=None, until=None, provider: Optional[str] = None) -> list:
    rng, args = _range_clause(since, until)
    prov, prov_args = _provider_clause(provider)
    sql = f"""
      SELECT tool_name,
             COUNT(*) AS calls,
             COALESCE(SUM(result_tokens),0) AS result_tokens
        FROM tool_calls
       WHERE tool_name != '_tool_result' {rng}{prov}
       GROUP BY tool_name
       ORDER BY calls DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, [*args, *prov_args])]


def ensure_session_rollups(db_path) -> dict:
    """Refresh per-session aggregates used to identify the latest scanned session.

    A session starts at the first scanned record timestamp for its session_id.
    Its usage is the sum of all rows with that session_id. Its visible end is
    the latest scanned record timestamp; local logs do not expose an explicit
    close event. The latest scanned session is therefore the latest-ended
    session per provider, and the latest-ended session overall for all-provider
    views.
    """
    with connect(db_path) as c:
        signature = _snapshot_signature(c)
        row = c.execute(
            "SELECT v FROM usage_snapshot_meta WHERE k='session_rollup_signature'"
        ).fetchone()
        if row and row["v"] == signature:
            return {"rebuilt": False, "signature": json.loads(signature)}
        _rebuild_session_rollups(c)
        c.execute(
            "INSERT OR REPLACE INTO usage_snapshot_meta (k, v) VALUES ('session_rollup_signature', ?)",
            (signature,),
        )
        c.commit()
        return {"rebuilt": True, "signature": json.loads(signature)}


def current_session(db_path, provider: Optional[str] = None) -> Optional[dict]:
    ensure_session_rollups(db_path)
    prov, prov_args = _provider_clause(provider)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    sql = f"""
      SELECT *
        FROM session_rollups
       WHERE ended_at <= ? {prov}
       ORDER BY ended_at DESC, started_at DESC
       LIMIT 1
    """
    with connect(db_path) as c:
        row = c.execute(sql, [now, *prov_args]).fetchone()
        if not row:
            return None
        result = dict(row)
        result["models"] = _session_model_rows(c, result["session_id"])
        return result


DEFAULT_USAGE_LIMIT_SETTINGS = {
    "session_tokens": None,
    "hourly_tokens": None,
    "weekly_tokens": None,
    "weekly_enabled": True,
    "week_start_day": 1,
    "caution_pct": 75,
    "near_pct": 90,
    "active_session_window_minutes": 20,
    "providers": {
        "claude": {"session_tokens": None, "hourly_tokens": None, "weekly_tokens": None},
        "codex": {"session_tokens": None, "hourly_tokens": None, "weekly_tokens": None},
    },
}


def usage_limit_settings(db_path) -> dict:
    with connect(db_path) as c:
        row = c.execute("SELECT v FROM settings WHERE k='usage_limits'").fetchone()
    if not row:
        return json.loads(json.dumps(DEFAULT_USAGE_LIMIT_SETTINGS))
    try:
        saved = json.loads(row["v"] or "{}")
    except json.JSONDecodeError:
        saved = {}
    return _normalize_usage_limit_settings(saved)


def set_usage_limit_settings(db_path, payload: dict) -> dict:
    settings = _normalize_usage_limit_settings(payload or {})
    with connect(db_path) as c:
        c.execute(
            "INSERT OR REPLACE INTO settings (k, v) VALUES ('usage_limits', ?)",
            (json.dumps(settings, sort_keys=True),),
        )
        c.commit()
    return settings


def _positive_int_or_none(value) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        parsed = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _bounded_int(value, fallback: int, low: int, high: int) -> int:
    try:
        parsed = int(round(float(value)))
    except (TypeError, ValueError):
        parsed = fallback
    return max(low, min(high, parsed))


def _provider_limit_settings(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "session_tokens": _positive_int_or_none(raw.get("session_tokens")),
        "hourly_tokens": _positive_int_or_none(raw.get("hourly_tokens")),
        "weekly_tokens": _positive_int_or_none(raw.get("weekly_tokens")),
    }


def _normalize_usage_limit_settings(raw: dict) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    caution = _bounded_int(raw.get("caution_pct"), 75, 1, 99)
    near = _bounded_int(raw.get("near_pct"), 90, 1, 99)
    if near <= caution:
        near = min(99, caution + 1)
        if near <= caution:
            caution = max(1, near - 1)
    providers_raw = raw.get("providers") if isinstance(raw.get("providers"), dict) else {}
    return {
        "session_tokens": _positive_int_or_none(raw.get("session_tokens")),
        "hourly_tokens": _positive_int_or_none(raw.get("hourly_tokens")),
        "weekly_tokens": _positive_int_or_none(raw.get("weekly_tokens")),
        "weekly_enabled": bool(raw.get("weekly_enabled", True)),
        "week_start_day": _bounded_int(raw.get("week_start_day"), 1, 0, 6),
        "caution_pct": caution,
        "near_pct": near,
        "active_session_window_minutes": _bounded_int(
            raw.get("active_session_window_minutes"), 20, 1, 1440
        ),
        "providers": {
            "claude": _provider_limit_settings(providers_raw.get("claude")),
            "codex": _provider_limit_settings(providers_raw.get("codex")),
        },
    }


def recent_sessions(
    db_path,
    limit: int = 20,
    since=None,
    until=None,
    provider: Optional[str] = None,
    offset: int = 0,
) -> list:
    ensure_session_rollups(db_path)
    where, args = [], []
    if since:
        where.append("ended_at >= ?")
        args.append(since)
    if until:
        where.append("started_at < ?")
        args.append(until)
    rng = (" AND " + " AND ".join(where)) if where else ""
    prov, prov_args = _provider_clause(provider)
    sql = f"""
      SELECT session_id, project_slug, provider, session_label,
             project_name, started_at AS started, ended_at AS ended,
             turns, input_tokens + output_tokens AS tokens, billable_tokens,
             input_tokens, output_tokens, cache_read_tokens,
             cache_create_5m_tokens, cache_create_1h_tokens,
             primary_model, model_count, is_current
        FROM session_rollups
       WHERE 1=1 {rng}{prov}
       ORDER BY ended DESC
       LIMIT ?
      OFFSET ?
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, [*args, *prov_args, limit, offset])]
    return rows


def sessions_for_project(db_path, slug: str, limit: int = 20, since=None, until=None) -> list:
    """Same shape as `recent_sessions`, scoped to sessions that touched `slug`."""
    ensure_session_rollups(db_path)
    where, args = [], []
    if since:
        where.append("ended_at >= ?")
        args.append(since)
    if until:
        where.append("started_at < ?")
        args.append(until)
    rng = (" AND " + " AND ".join(where)) if where else ""
    sql = f"""
      SELECT session_id, project_slug, provider, session_label,
             project_name, started_at AS started, ended_at AS ended,
             turns, input_tokens + output_tokens AS tokens, billable_tokens,
             input_tokens, output_tokens, cache_read_tokens,
             cache_create_5m_tokens, cache_create_1h_tokens,
             primary_model, model_count, is_current
        FROM session_rollups
       WHERE session_id IN (
               SELECT DISTINCT session_id FROM messages WHERE project_slug = ?
             ) {rng}
       ORDER BY ended DESC
       LIMIT ?
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, [slug, *args, limit])]


def prompts_for_project(db_path, slug: str, limit: int = 10, sort: str = "tokens", since=None, until=None) -> list:
    """Mirror of `expensive_prompts`, scoped to sessions that touched `slug`."""
    order = "u.timestamp DESC" if sort == "recent" else "billable_tokens DESC"
    where = ["u.type='user'", "u.prompt_text IS NOT NULL"]
    args: list = []
    if since:
        where.append("u.timestamp >= ?")
        args.append(since)
    if until:
        where.append("u.timestamp < ?")
        args.append(until)
    sql = f"""
      SELECT u.uuid AS user_uuid, u.session_id, u.project_slug, u.timestamp,
             COALESCE(a.provider, u.provider, 'claude') AS provider,
             COALESCE(a.session_label, u.session_label) AS session_label,
             u.prompt_text, u.prompt_chars,
             a.uuid AS assistant_uuid, a.model,
             COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0)
               +COALESCE(a.cache_create_5m_tokens,0)+COALESCE(a.cache_create_1h_tokens,0) AS billable_tokens,
             COALESCE(a.cache_read_tokens,0) AS cache_read_tokens
        FROM messages u
        JOIN messages a ON a.parent_uuid = u.uuid AND a.type='assistant'
       WHERE {' AND '.join(where)}
         AND u.session_id IN (
               SELECT DISTINCT session_id FROM messages WHERE project_slug = ?
             )
       ORDER BY {order}
       LIMIT ?
    """
    args.append(slug)
    args.append(limit)
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, args)]
        for row in rows:
            _enrich_prompt_row(c, row)
        return rows


def session_turns(db_path, session_id: str) -> list:
    sql = """
      SELECT uuid, parent_uuid, session_id, session_label, project_slug, provider,
             type, timestamp, model, is_sidechain, agent_id,
             input_tokens, output_tokens, cache_read_tokens,
             cache_create_5m_tokens, cache_create_1h_tokens,
             prompt_text, prompt_chars, tool_calls_json, cwd
        FROM messages
       WHERE session_id = ?
       ORDER BY timestamp ASC
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, (session_id,))]
        if not rows:
            return rows

        tools = c.execute(
            """
              SELECT id, message_uuid, tool_name, target, result_tokens, is_error, timestamp
                FROM tool_calls
               WHERE session_id = ?
               ORDER BY timestamp ASC, id ASC
            """,
            (session_id,),
        ).fetchall()
        by_message = {}
        for tool in tools:
            by_message.setdefault(tool["message_uuid"], []).append(dict(tool))
        for row in rows:
            row["tool_calls"] = by_message.get(row["uuid"], [])
        return rows


def _session_model_rows(conn, session_id: str) -> list:
    rows = conn.execute(
        """
          SELECT COALESCE(model, 'unknown') AS model,
                 COUNT(*) AS turns,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                 COALESCE(SUM(cache_create_5m_tokens), 0) AS cache_create_5m_tokens,
                 COALESCE(SUM(cache_create_1h_tokens), 0) AS cache_create_1h_tokens,
                 COALESCE(SUM(input_tokens + output_tokens + cache_create_5m_tokens + cache_create_1h_tokens), 0)
                   AS billable_tokens
            FROM messages
           WHERE session_id = ?
             AND type = 'assistant'
           GROUP BY COALESCE(model, 'unknown')
           ORDER BY billable_tokens DESC
        """,
        (session_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def _rebuild_session_rollups(conn) -> None:
    conn.execute("DELETE FROM session_rollups")
    computed_at = time.time()
    conn.execute(
        """
          INSERT OR REPLACE INTO session_rollups (
            session_id, provider, session_label, project_slug, project_name, cwd,
            started_at, ended_at, computed_at, is_current, turns, records,
            input_tokens, output_tokens, cache_read_tokens,
            cache_create_5m_tokens, cache_create_1h_tokens, billable_tokens,
            primary_model, model_count
          )
          SELECT session_id,
                 COALESCE(MAX(provider), 'claude') AS provider,
                 MAX(session_label) AS session_label,
                 COALESCE(MAX(project_slug), '') AS project_slug,
                 '' AS project_name,
                 MAX(cwd) AS cwd,
                 MIN(timestamp) AS started_at,
                 MAX(timestamp) AS ended_at,
                 ? AS computed_at,
                 0 AS is_current,
                 SUM(CASE WHEN type = 'user' THEN 1 ELSE 0 END) AS turns,
                 COUNT(*) AS records,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                 COALESCE(SUM(cache_create_5m_tokens), 0) AS cache_create_5m_tokens,
                 COALESCE(SUM(cache_create_1h_tokens), 0) AS cache_create_1h_tokens,
                 COALESCE(SUM(input_tokens + output_tokens + cache_create_5m_tokens + cache_create_1h_tokens), 0)
                   AS billable_tokens,
                 NULL AS primary_model,
                 0 AS model_count
            FROM messages
           WHERE session_id IS NOT NULL
             AND timestamp IS NOT NULL
           GROUP BY session_id
        """,
        (computed_at,),
    )
    rows = conn.execute("SELECT session_id, project_slug FROM session_rollups").fetchall()
    for row in rows:
        session_id = row["session_id"]
        project_slug = row["project_slug"]
        cwds = [
            r["cwd"]
            for r in conn.execute(
                "SELECT DISTINCT cwd FROM messages WHERE session_id = ? AND cwd IS NOT NULL",
                (session_id,),
            )
        ]
        models = _session_model_rows(conn, session_id)
        primary_model = models[0]["model"] if models else None
        conn.execute(
            """
              UPDATE session_rollups
                 SET project_name = ?,
                     primary_model = ?,
                     model_count = ?
               WHERE session_id = ?
            """,
            (best_project_name(cwds, project_slug), primary_model, len(models), session_id),
        )
    current_rows = conn.execute(
        """
          SELECT provider, session_id
            FROM session_rollups sr
           WHERE ended_at = (
             SELECT MAX(ended_at)
               FROM session_rollups
              WHERE provider = sr.provider
           )
        """
    ).fetchall()
    for row in current_rows:
        conn.execute(
            "UPDATE session_rollups SET is_current = 1 WHERE provider = ? AND session_id = ?",
            (row["provider"], row["session_id"]),
        )


def daily_token_breakdown(db_path, since=None, until=None, provider: Optional[str] = None) -> list:
    """One row per day: stacked bar data for input/output/cache_read/cache_create."""
    rng, args = _range_clause(since, until)
    prov, prov_args = _provider_clause(provider)
    sql = f"""
      SELECT substr(timestamp, 1, 10) AS day,
             COALESCE(SUM(input_tokens),0)      AS input_tokens,
             COALESCE(SUM(output_tokens),0)     AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)
               + COALESCE(SUM(cache_create_1h_tokens),0) AS cache_create_tokens
        FROM messages
       WHERE timestamp IS NOT NULL {rng}{prov}
       GROUP BY day
       ORDER BY day ASC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, [*args, *prov_args])]


def skill_breakdown(db_path, since=None, until=None, provider: Optional[str] = None) -> list:
    """Per-skill invocation counts, distinct sessions, last-used timestamp.

    Includes both direct Skill tool invocations and Task-based dispatches where
    the Task target is skill-shaped (e.g. "superpowers:brainstorming").
    """
    rng, args = _range_clause(since, until)
    prov, prov_args = _provider_clause(provider)
    sql = f"""
      SELECT skill,
             COUNT(*) AS invocations,
             COUNT(DISTINCT session_id) AS sessions,
             MAX(timestamp) AS last_used
        FROM (
          SELECT target AS skill, session_id, timestamp
            FROM tool_calls
           WHERE tool_name = 'Skill' AND target IS NOT NULL AND target != '' {rng}{prov}
          UNION ALL
          SELECT target AS skill, session_id, timestamp
            FROM tool_calls
           WHERE tool_name = 'Task' AND target IS NOT NULL AND target != '' AND INSTR(target, ':') > 0 {rng}{prov}
        )
       GROUP BY skill
       ORDER BY invocations DESC
    """
    with connect(db_path) as c:
        query_args = [*args, *prov_args, *args, *prov_args]
        return [dict(r) for r in c.execute(sql, query_args)]


def model_breakdown(db_path, since=None, until=None, provider: Optional[str] = None) -> list:
    """Per-model token totals + turn count. Caller computes cost via pricing."""
    rng, args = _range_clause(since, until)
    prov, prov_args = _provider_clause(provider)
    sql = f"""
      SELECT COALESCE(model, 'unknown') AS model,
             COUNT(*) AS turns,
             COALESCE(SUM(input_tokens),0)            AS input_tokens,
             COALESCE(SUM(output_tokens),0)           AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages
       WHERE type = 'assistant' {rng}{prov}
       GROUP BY model
       ORDER BY (input_tokens + output_tokens + cache_create_5m_tokens + cache_create_1h_tokens) DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, [*args, *prov_args])]


def provider_breakdown(db_path, since=None, until=None, provider: Optional[str] = None) -> list:
    rng, args = _range_clause(since, until)
    prov, prov_args = _provider_clause(provider)
    sql = f"""
      SELECT COALESCE(provider, 'claude') AS provider,
             COUNT(DISTINCT session_id) AS sessions,
             SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns,
             COALESCE(SUM(input_tokens),0)            AS input_tokens,
             COALESCE(SUM(output_tokens),0)           AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages
       WHERE 1=1 {rng}{prov}
       GROUP BY COALESCE(provider, 'claude')
       ORDER BY (input_tokens + output_tokens + cache_create_5m_tokens + cache_create_1h_tokens) DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, [*args, *prov_args])]


def ensure_usage_snapshots(db_path) -> dict:
    """Refresh cached daily/weekly aggregates only when message totals changed."""
    with connect(db_path) as c:
        signature = _snapshot_signature(c)
        row = c.execute(
            "SELECT v FROM usage_snapshot_meta WHERE k='message_signature'"
        ).fetchone()
        if row and row["v"] == signature:
            return {"rebuilt": False, "signature": json.loads(signature)}
        _rebuild_usage_snapshots(c)
        c.execute(
            "INSERT OR REPLACE INTO usage_snapshot_meta (k, v) VALUES ('message_signature', ?)",
            (signature,),
        )
        c.commit()
        return {"rebuilt": True, "signature": json.loads(signature)}


def snapshot_rollups(db_path, period: str = "week", provider: Optional[str] = None, limit: int = 12) -> list:
    provider_key = _normalize_provider(provider) or "all"
    period = "day" if period == "day" else "week"
    limit = max(1, min(int(limit or 12), 260))
    sql = """
      SELECT *
        FROM usage_snapshots
       WHERE period = ?
         AND provider = ?
         AND dimension = 'total'
       ORDER BY start_date DESC
       LIMIT ?
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, (period, provider_key, limit))]
    rows.reverse()
    return rows


def snapshot_dimension_rows(
    db_path,
    dimension: str,
    period: str = "week",
    provider: Optional[str] = None,
    since_start: Optional[str] = None,
    limit: Optional[int] = None,
) -> list:
    if dimension not in {"project", "model", "provider", "project_model"}:
        raise ValueError("unsupported snapshot dimension")
    provider_key = _normalize_provider(provider) or "all"
    period = "day" if period == "day" else "week"
    where = [
        "period = ?",
        "provider = ?",
        "dimension = ?",
    ]
    args = [period, provider_key, dimension]
    if since_start:
        where.append("start_date >= ?")
        args.append(since_start)
    sql = f"""
      SELECT *
        FROM usage_snapshots
       WHERE {" AND ".join(where)}
       ORDER BY start_date ASC
    """
    rows_limit = None
    if limit is not None:
        rows_limit = max(1, min(int(limit), 1000))
        sql += " LIMIT ?"
        args.append(rows_limit)
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, args)]


def _snapshot_signature(conn) -> str:
    row = conn.execute(
        """
        SELECT COUNT(*) AS messages,
               COUNT(DISTINCT session_id) AS sessions,
               COALESCE(MAX(timestamp), '') AS max_timestamp,
               COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens
                 + cache_create_5m_tokens + cache_create_1h_tokens), 0) AS token_sum
          FROM messages
        """
    ).fetchone()
    return json.dumps(dict(row), sort_keys=True)


def _rebuild_usage_snapshots(conn) -> None:
    conn.execute("DELETE FROM usage_snapshots")
    project_labels = _project_labels(conn)

    for period, start_expr, end_modifier in (
        ("day", "substr(timestamp, 1, 10)", "+1 day"),
        (
            "week",
            "date(substr(timestamp, 1, 10), printf('-%d days', (CAST(strftime('%w', substr(timestamp, 1, 10)) AS INTEGER) + 6) % 7))",
            "+7 days",
        ),
    ):
        _insert_snapshot_dimension(
            conn,
            period,
            start_expr,
            end_modifier,
            dimension="total",
            dimension_expr="'total'",
            label_expr="'All usage'",
            where="timestamp IS NOT NULL",
        )
        _insert_snapshot_dimension(
            conn,
            period,
            start_expr,
            end_modifier,
            dimension="provider",
            dimension_expr="COALESCE(provider, 'claude')",
            label_expr="COALESCE(provider, 'claude')",
            where="timestamp IS NOT NULL",
            all_scope_only=True,
        )
        _insert_snapshot_dimension(
            conn,
            period,
            start_expr,
            end_modifier,
            dimension="project",
            dimension_expr="project_slug",
            label_expr="project_slug",
            where="timestamp IS NOT NULL",
        )
        _insert_snapshot_dimension(
            conn,
            period,
            start_expr,
            end_modifier,
            dimension="model",
            dimension_expr="COALESCE(model, 'unknown')",
            label_expr="COALESCE(model, 'unknown')",
            where="timestamp IS NOT NULL AND type = 'assistant'",
        )
        _insert_snapshot_dimension(
            conn,
            period,
            start_expr,
            end_modifier,
            dimension="project_model",
            dimension_expr="project_slug || char(9) || COALESCE(model, 'unknown')",
            label_expr="project_slug || ' · ' || COALESCE(model, 'unknown')",
            where="timestamp IS NOT NULL AND type = 'assistant'",
        )

    for slug, label in project_labels.items():
        conn.execute(
            """
            UPDATE usage_snapshots
               SET dimension_label = ?
             WHERE dimension = 'project'
               AND dimension_key = ?
            """,
            (label, slug),
        )
        conn.execute(
            """
            UPDATE usage_snapshots
               SET dimension_label = ? || ' · ' || substr(dimension_key, instr(dimension_key, char(9)) + 1)
             WHERE dimension = 'project_model'
               AND substr(dimension_key, 1, instr(dimension_key, char(9)) - 1) = ?
            """,
            (label, slug),
        )


def _project_labels(conn) -> dict:
    rows = conn.execute(
        """
        SELECT project_slug, cwd
          FROM messages
         WHERE project_slug IS NOT NULL
           AND cwd IS NOT NULL
         GROUP BY project_slug, cwd
        """
    ).fetchall()
    by_slug = {}
    for row in rows:
        by_slug.setdefault(row["project_slug"], []).append(row["cwd"])
    labels = {}
    slugs = set(by_slug)
    slugs.update(
        row["project_slug"]
        for row in conn.execute("SELECT DISTINCT project_slug FROM messages WHERE project_slug IS NOT NULL")
    )
    for slug in slugs:
        labels[slug] = best_project_name(by_slug.get(slug, []), slug)
    return labels


def _insert_snapshot_dimension(
    conn,
    period: str,
    start_expr: str,
    end_modifier: str,
    dimension: str,
    dimension_expr: str,
    label_expr: str,
    where: str,
    all_scope_only: bool = False,
) -> None:
    scopes = [("'all'", [])]
    if not all_scope_only:
        scopes.append(("COALESCE(provider, 'claude')", []))
    for provider_expr, args in scopes:
        sql = f"""
          INSERT OR REPLACE INTO usage_snapshots (
            period, start_date, end_date, provider, dimension, dimension_key, dimension_label,
            sessions, turns, input_tokens, output_tokens, cache_read_tokens,
            cache_create_5m_tokens, cache_create_1h_tokens
          )
          SELECT ? AS period,
                 {start_expr} AS start_date,
                 date({start_expr}, ?) AS end_date,
                 {provider_expr} AS provider,
                 ? AS dimension,
                 {dimension_expr} AS dimension_key,
                 {label_expr} AS dimension_label,
                 COUNT(DISTINCT session_id) AS sessions,
                 SUM(CASE WHEN type = 'user' THEN 1 ELSE 0 END) AS turns,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                 COALESCE(SUM(cache_create_5m_tokens), 0) AS cache_create_5m_tokens,
                 COALESCE(SUM(cache_create_1h_tokens), 0) AS cache_create_1h_tokens
            FROM messages
           WHERE {where}
           GROUP BY start_date, {provider_expr}, dimension_key
        """
        conn.execute(sql, [period, end_modifier, dimension, *args])
