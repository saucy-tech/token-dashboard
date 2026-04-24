"""SQLite schema, connection, and shared query helpers."""
from __future__ import annotations

import re
import sqlite3
from contextlib import contextmanager
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
  tool_calls_json         TEXT,
  source                  TEXT NOT NULL DEFAULT 'claude'
);
CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_project   ON messages(project_slug);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_model     ON messages(model);
CREATE INDEX IF NOT EXISTS idx_messages_msgid     ON messages(session_id, message_id);
CREATE INDEX IF NOT EXISTS idx_messages_source    ON messages(source);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uuid  TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  project_slug  TEXT    NOT NULL,
  tool_name     TEXT    NOT NULL,
  target        TEXT,
  result_tokens INTEGER,
  is_error      INTEGER NOT NULL DEFAULT 0,
  timestamp     TEXT    NOT NULL,
  source        TEXT NOT NULL DEFAULT 'claude'
);
CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tools_name    ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_target  ON tool_calls(target);
CREATE INDEX IF NOT EXISTS idx_tools_source   ON tool_calls(source);

CREATE TABLE IF NOT EXISTS plan (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS dismissed_tips (
  tip_key       TEXT PRIMARY KEY,
  dismissed_at  REAL NOT NULL
);
"""


def default_db_path() -> Path:
    return Path.home() / ".claude" / "token-dashboard.db"


def init_db(path: Union[str, Path]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as c:
        _migrate_add_message_id(c)
        # Before SCHEMA (indexes on `source`), add column on upgraded DBs.
        _migrate_add_source(c)
        c.executescript(SCHEMA)


def _migrate_add_source(conn) -> None:
    """Add messages.source / tool_calls.source for Claude vs Codex (default claude)."""
    for table in ("messages", "tool_calls"):
        has = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()
        if not has:
            continue
        cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if "source" in cols:
            continue
        conn.execute(
            f"ALTER TABLE {table} ADD COLUMN source TEXT NOT NULL DEFAULT 'claude'"
        )
    conn.commit()


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


@contextmanager
def connect(path: Union[str, Path]):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
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


def normalize_source_param(source: Optional[str]) -> Optional[str]:
    """None → no filter (all agents). ``all`` same. ``claude`` / ``codex`` only."""
    if not source:
        return None
    s = str(source).strip().lower()
    if s in ("", "all"):
        return None
    if s in ("claude", "codex"):
        return s
    return None


def _msg_source_sql(alias: str, source: Optional[str]) -> tuple[str, list]:
    if not source:
        return "", []
    return f" AND {alias}.source = ?", [source]


def _tool_source_sql(source: Optional[str]) -> tuple[str, list]:
    if not source:
        return "", []
    return " AND source = ?", [source]


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


def overview_totals(db_path, since=None, until=None, source: Optional[str] = None) -> dict:
    rng, args = _range_clause(since, until)
    src, sargs = _msg_source_sql("m", normalize_source_param(source))
    sql = f"""
      SELECT COUNT(DISTINCT m.session_id) AS sessions,
             SUM(CASE WHEN m.type='user' THEN 1 ELSE 0 END) AS turns,
             COALESCE(SUM(m.input_tokens),0)            AS input_tokens,
             COALESCE(SUM(m.output_tokens),0)           AS output_tokens,
             COALESCE(SUM(m.cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(m.cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(m.cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages m WHERE 1=1 {rng} {src}
    """
    with connect(db_path) as c:
        return dict(c.execute(sql, [*args, *sargs]).fetchone())


def expensive_prompts(
    db_path, limit: int = 50, sort: str = "tokens", source: Optional[str] = None,
) -> list:
    """User prompt joined with the immediately-following assistant turn's tokens.

    sort="tokens" (default) → largest billable first.
    sort="recent"           → newest first.
    """
    order = "u.timestamp DESC" if sort == "recent" else "billable_tokens DESC"
    src = normalize_source_param(source)
    src_sql, sargs = (" AND u.source = ? AND a.source = ?", [src, src]) if src else ("", [])
    sql = f"""
      SELECT u.uuid AS user_uuid, u.session_id, u.project_slug, u.timestamp,
             u.prompt_text, u.prompt_chars,
             a.uuid AS assistant_uuid, a.model,
             COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0)
               +COALESCE(a.cache_create_5m_tokens,0)+COALESCE(a.cache_create_1h_tokens,0) AS billable_tokens,
             COALESCE(a.cache_read_tokens,0) AS cache_read_tokens
        FROM messages u
        JOIN messages a ON a.parent_uuid = u.uuid AND a.type='assistant'
       WHERE u.type='user' AND u.prompt_text IS NOT NULL {src_sql}
       ORDER BY {order}
       LIMIT ?
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, (*sargs, limit))]


def project_summary(db_path, since=None, until=None, source: Optional[str] = None) -> list:
    rng, args = _range_clause(since, until)
    src = normalize_source_param(source)
    src_sql, sargs = _msg_source_sql("m", src)
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
       WHERE 1=1 {rng} {src_sql}
       GROUP BY project_slug
       ORDER BY billable_tokens DESC
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, [*args, *sargs])]
        cwd_src, cwd_args = _msg_source_sql("m", src)
        for r in rows:
            cwds = [row["cwd"] for row in c.execute(
                f"SELECT DISTINCT cwd FROM messages m WHERE project_slug=? AND cwd IS NOT NULL{cwd_src}",
                (r["project_slug"], *cwd_args),
            )]
            r["project_name"] = best_project_name(cwds, r["project_slug"])
    return rows


def tool_token_breakdown(db_path, since=None, until=None, source: Optional[str] = None) -> list:
    rng, args = _range_clause(since, until)
    src_sql, sargs = _tool_source_sql(normalize_source_param(source))
    sql = f"""
      SELECT tool_name,
             COUNT(*) AS calls,
             COALESCE(SUM(result_tokens),0) AS result_tokens
        FROM tool_calls
       WHERE tool_name != '_tool_result' {rng} {src_sql}
       GROUP BY tool_name
       ORDER BY calls DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, [*args, *sargs])]


def recent_sessions(
    db_path, limit: int = 20, since=None, until=None, source: Optional[str] = None,
) -> list:
    rng, args = _range_clause(since, until)
    src = normalize_source_param(source)
    src_sql, sargs = _msg_source_sql("m", src)
    sql = f"""
      SELECT session_id, project_slug,
             MIN(timestamp) AS started, MAX(timestamp) AS ended,
             SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns,
             SUM(input_tokens)+SUM(output_tokens) AS tokens
        FROM messages m
       WHERE 1=1 {rng} {src_sql}
       GROUP BY session_id
       ORDER BY ended DESC
       LIMIT ?
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, (*args, *sargs, limit))]
        cwd_src, cwd_args = _msg_source_sql("m", src)
        slug_cache = {}
        for r in rows:
            slug = r["project_slug"]
            if slug not in slug_cache:
                cwds = [row["cwd"] for row in c.execute(
                    f"SELECT DISTINCT cwd FROM messages m WHERE project_slug=? AND cwd IS NOT NULL{cwd_src}",
                    (slug, *cwd_args),
                )]
                slug_cache[slug] = best_project_name(cwds, slug)
            r["project_name"] = slug_cache[slug]
    return rows


def session_turns(db_path, session_id: str, source: Optional[str] = None) -> list:
    src = normalize_source_param(source)
    src_sql, sargs = _msg_source_sql("m", src)
    sql = f"""
      SELECT uuid, parent_uuid, type, timestamp, model, is_sidechain, agent_id,
             input_tokens, output_tokens, cache_read_tokens,
             cache_create_5m_tokens, cache_create_1h_tokens,
             prompt_text, prompt_chars, tool_calls_json, project_slug, cwd
        FROM messages m
       WHERE m.session_id = ? {src_sql}
       ORDER BY m.timestamp ASC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, (session_id, *sargs))]


def daily_token_breakdown(db_path, since=None, until=None, source: Optional[str] = None) -> list:
    """One row per day: stacked bar data for input/output/cache_read/cache_create."""
    rng, args = _range_clause(since, until)
    src_sql, sargs = _msg_source_sql("m", normalize_source_param(source))
    sql = f"""
      SELECT substr(m.timestamp, 1, 10) AS day,
             COALESCE(SUM(m.input_tokens),0)      AS input_tokens,
             COALESCE(SUM(m.output_tokens),0)     AS output_tokens,
             COALESCE(SUM(m.cache_read_tokens),0) AS cache_read_tokens,
             COALESCE(SUM(m.cache_create_5m_tokens),0)
               + COALESCE(SUM(m.cache_create_1h_tokens),0) AS cache_create_tokens
        FROM messages m
       WHERE m.timestamp IS NOT NULL {rng} {src_sql}
       GROUP BY day
       ORDER BY day ASC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, [*args, *sargs])]


def skill_breakdown(db_path, since=None, until=None, source: Optional[str] = None) -> list:
    """Per-skill invocation counts, distinct sessions, last-used timestamp.

    Token attribution per skill is not included: in Claude Code, a Skill's
    content is loaded via a system-reminder on the next turn, not as the
    tool_result body — so `result_tokens` on _tool_result rows reflects the
    activation ack (tiny), not the skill definition (which is what actually
    fills context). A future schema change (storing tool_use_id on the
    invocation row) could enable precise attribution; for now we only expose
    the reliable counts.
    """
    rng, args = _range_clause(since, until)
    src_sql, sargs = _tool_source_sql(normalize_source_param(source))
    sql = f"""
      SELECT target AS skill,
             COUNT(*) AS invocations,
             COUNT(DISTINCT session_id) AS sessions,
             MAX(timestamp) AS last_used
        FROM tool_calls
       WHERE tool_name = 'Skill' AND target IS NOT NULL AND target != '' {rng} {src_sql}
       GROUP BY target
       ORDER BY invocations DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, [*args, *sargs])]


def model_breakdown(db_path, since=None, until=None, source: Optional[str] = None) -> list:
    """Per-model token totals + turn count. Caller computes cost via pricing."""
    rng, args = _range_clause(since, until)
    src_sql, sargs = _msg_source_sql("m", normalize_source_param(source))
    sql = f"""
      SELECT COALESCE(model, 'unknown') AS model,
             COUNT(*) AS turns,
             COALESCE(SUM(m.input_tokens),0)            AS input_tokens,
             COALESCE(SUM(m.output_tokens),0)           AS output_tokens,
             COALESCE(SUM(m.cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(m.cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(m.cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages m
       WHERE m.type = 'assistant' {rng} {src_sql}
       GROUP BY model
       ORDER BY (SUM(m.input_tokens) + SUM(m.output_tokens) + SUM(m.cache_create_5m_tokens) + SUM(m.cache_create_1h_tokens)) DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, [*args, *sargs])]


def sources_snapshot(db_path, claude_projects_dir: str, codex_projects_dir: Optional[str]) -> dict:
    """Configured transcript roots + per-source row counts (for home / settings)."""
    claude_path = Path(claude_projects_dir)
    codex_raw = (codex_projects_dir or "").strip()
    codex_path = Path(codex_raw) if codex_raw else None
    with connect(db_path) as c:
        claude_n = c.execute(
            "SELECT COUNT(*) FROM messages WHERE source='claude'",
        ).fetchone()[0]
        codex_n = c.execute(
            "SELECT COUNT(*) FROM messages WHERE source='codex'",
        ).fetchone()[0]
    return {
        "sources": [
            {
                "id": "claude",
                "label": "Claude Code",
                "projects_dir": str(claude_path),
                "configured": True,
                "reachable": claude_path.is_dir(),
                "message_rows": claude_n,
            },
            {
                "id": "codex",
                "label": "Codex",
                "projects_dir": str(codex_path) if codex_path else "",
                "configured": bool(codex_path),
                "reachable": bool(codex_path and codex_path.is_dir()),
                "message_rows": codex_n,
            },
        ],
    }
