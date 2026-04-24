"""Rule-based tips engine — produces actionable suggestions from SQLite."""
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote

from .db import connect


CORRECTION_RE = re.compile(
    r"^\s*(no|wrong|wait|actually|not quite|that's not|thats not|you missed|i said|i asked|stop)\b",
    re.IGNORECASE,
)
KEEP_GOING_RE = re.compile(r"^\s*(keep going|continue|go on|finish|proceed)\s*[.!?]*\s*$", re.IGNORECASE)
WORD_RE = re.compile(r"\w+")

READ_TOOL_SQL = """
(
  LOWER(tool_name) LIKE '%read%'
  OR LOWER(tool_name) LIKE '%grep%'
  OR LOWER(tool_name) LIKE '%glob%'
  OR LOWER(tool_name) = 'ls'
  OR (
    LOWER(tool_name) = 'exec_command'
    AND (
      LOWER(TRIM(COALESCE(target, ''))) = 'ls'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'ls %'
      OR LOWER(TRIM(COALESCE(target, ''))) = 'rg'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'rg %'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'sed %'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'cat %'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'find %'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'nl %'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'wc %'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'head %'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'tail %'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'pwd%'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'git status%'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'git diff%'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'git show%'
      OR LOWER(TRIM(COALESCE(target, ''))) LIKE 'git log%'
    )
  )
)
"""

EDIT_TOOL_SQL = """
(
  LOWER(tool_name) LIKE '%edit%'
  OR LOWER(tool_name) LIKE '%write%'
  OR LOWER(tool_name) = 'apply_patch'
)
"""


def _iso_days_ago(today_iso: str, n: int) -> str:
    d = datetime.fromisoformat(today_iso.replace("Z", ""))
    return (d - timedelta(days=n)).isoformat()


def _key(category: str, scope: str) -> str:
    return f"{category}:{scope}"


def _provider_label(provider: Optional[str]) -> str:
    value = (provider or "").strip().lower()
    if not value:
        return "Agent"
    return value[0].upper() + value[1:]


def _session_link(session_id: str, provider: Optional[str] = None, label: Optional[str] = None) -> dict:
    href = "#/sessions/" + quote(session_id, safe="")
    if provider:
        href += "?provider=" + quote(provider, safe="")
    return {"type": "session", "label": label or f"Session {session_id[:8]}", "href": href}


def _prompt_link(user_uuid: str, label: Optional[str] = None) -> dict:
    return {"type": "prompt", "label": label or f"Prompt {user_uuid[:8]}", "href": "#/prompts?prompt=" + quote(user_uuid, safe="")}


def _affected_sessions(c, where_sql: str, args: list, limit: int = 5) -> List[dict]:
    rows = c.execute(f"""
      SELECT session_id, COALESCE(provider, 'claude') AS provider, COUNT(*) AS n
        FROM tool_calls
       WHERE {where_sql}
       GROUP BY session_id, provider
       ORDER BY n DESC
       LIMIT ?
    """, [*args, limit]).fetchall()
    return [_session_link(r["session_id"], r["provider"], f"{r['session_id'][:8]} ({r['n']}x)") for r in rows]


def _affected_prompts(c, session_id: str, provider: Optional[str] = None, limit: int = 3) -> List[dict]:
    rows = c.execute("""
      SELECT uuid, prompt_text
        FROM messages
       WHERE session_id = ? AND type = 'user' AND prompt_text IS NOT NULL
       ORDER BY timestamp DESC
       LIMIT ?
    """, (session_id, limit)).fetchall()
    return [
        _prompt_link(r["uuid"], (r["prompt_text"] or "Prompt")[:48])
        for r in rows
    ]


def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo:
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _word_set(text: str) -> set:
    return {m.group(0).lower() for m in WORD_RE.finditer(text or "")}


def _jaccard(a: str, b: str) -> float:
    sa = _word_set(a)
    sb = _word_set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _is_dismissed(db_path, key: str) -> bool:
    with connect(db_path) as c:
        r = c.execute("SELECT dismissed_at FROM dismissed_tips WHERE tip_key=?", (key,)).fetchone()
    if not r:
        return False
    return (time.time() - r["dismissed_at"]) < 14 * 86400


def dismiss_tip(db_path, key: str) -> None:
    with connect(db_path) as c:
        c.execute(
            "INSERT OR REPLACE INTO dismissed_tips (tip_key, dismissed_at) VALUES (?, ?)",
            (key, time.time()),
        )
        c.commit()


def cache_discipline_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    sql = """
      SELECT project_slug,
             SUM(cache_read_tokens) AS cr,
             SUM(input_tokens + cache_create_5m_tokens + cache_create_1h_tokens) AS rebuild
        FROM messages
       WHERE type='assistant' AND timestamp >= ?
       GROUP BY project_slug
       HAVING (cr + rebuild) > 100000
    """
    out = []
    with connect(db_path) as c:
        for row in c.execute(sql, (since,)):
            total = (row["cr"] or 0) + (row["rebuild"] or 0)
            hit = (row["cr"] or 0) / total if total else 0
            if hit < 0.40:
                key = _key("cache", row["project_slug"])
                if _is_dismissed(db_path, key):
                    continue
                out.append({
                    "key": key,
                    "category": "cache",
                    "title": f"Low cache hit rate in {row['project_slug']}",
                    "body": f"Cache hit rate is {hit*100:.0f}% over the last 7 days. Sessions that restart context frequently rebuild cache. Consider longer-lived sessions or fewer context resets.",
                    "scope": row["project_slug"],
                })
    return out


def repeated_target_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out = []
    with connect(db_path) as c:
        for row in c.execute("""
          SELECT target, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions,
                 SUM(COALESCE(result_tokens, 0)) AS result_tokens
            FROM tool_calls
           WHERE tool_name IN ('Read','Edit','Write') AND timestamp >= ?
           GROUP BY target HAVING n > 10
           ORDER BY n DESC LIMIT 10
        """, (since,)):
            key = _key("repeat-file", row["target"] or "?")
            if _is_dismissed(db_path, key):
                continue
            links = _affected_sessions(
                c,
                "tool_name IN ('Read','Edit','Write') AND timestamp >= ? AND target IS ?",
                [since, row["target"]],
            )
            out.append({
                "key": key, "category": "repeat-file",
                "title": f"{row['target']} read {row['n']} times",
                "body": f"This file was opened {row['n']} times across {row['sessions']} sessions in the past 7 days. That repeats context the agent already had, so the cost comes from re-sending similar file content into later turns.",
                "scope": row["target"],
                "why": f"Repeated file reads contributed {int(row['result_tokens'] or 0):,} local tool-result tokens.",
                "rule": "Keep a short local note for stable project facts, or ask the agent to read the file once and summarize what it will rely on before editing.",
                "links": links,
            })
        for row in c.execute("""
          SELECT target, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions,
                 SUM(COALESCE(result_tokens, 0)) AS result_tokens
            FROM tool_calls
           WHERE tool_name='Bash' AND timestamp >= ?
           GROUP BY target HAVING n > 15
           ORDER BY n DESC LIMIT 10
        """, (since,)):
            key = _key("repeat-bash", row["target"] or "?")
            if _is_dismissed(db_path, key):
                continue
            links = _affected_sessions(
                c,
                "tool_name='Bash' AND timestamp >= ? AND target IS ?",
                [since, row["target"]],
            )
            out.append({
                "key": key, "category": "repeat-bash",
                "title": f"`{row['target']}` ran {row['n']} times",
                "body": f"This bash command ran {row['n']} times across {row['sessions']} sessions in the past 7 days. The repeated pattern is expensive when each run returns logs the model has to ingest again.",
                "scope": row["target"],
                "why": f"Repeated command output contributed {int(row['result_tokens'] or 0):,} local tool-result tokens.",
                "rule": "Prefer targeted commands, quiet flags, or piping noisy output to head/tail unless the full log is needed.",
                "links": links,
            })
    return out


def right_size_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    sql = """
      SELECT COUNT(*) AS n,
             SUM(input_tokens+cache_create_5m_tokens+cache_create_1h_tokens) AS in_tok,
             SUM(output_tokens) AS out_tok
        FROM messages
       WHERE type='assistant' AND model LIKE '%opus%'
         AND output_tokens < 500 AND is_sidechain = 0
         AND timestamp >= ?
    """
    with connect(db_path) as c:
        row = c.execute(sql, (since,)).fetchone()
    if not row or (row["n"] or 0) < 10:
        return []
    api_opus   = ((row["in_tok"] or 0) * 15 + (row["out_tok"] or 0) * 75) / 1_000_000
    api_sonnet = ((row["in_tok"] or 0) *  3 + (row["out_tok"] or 0) * 15) / 1_000_000
    savings = api_opus - api_sonnet
    if savings < 1.0:
        return []
    key = _key("right-size", "opus-short-turns-7d")
    if _is_dismissed(db_path, key):
        return []
    return [{
        "key": key, "category": "right-size",
        "title": f"{row['n']} short Opus turns might fit on Sonnet",
        "body": f"Opus turns under 500 output tokens cost ~${api_opus:.2f} in the last 7 days. Sonnet would have cost ~${api_sonnet:.2f} (savings ~${savings:.2f}).",
        "scope": "opus-short-turns-7d",
    }]


def outlier_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out = []
    with connect(db_path) as c:
        big = c.execute("""
          SELECT COUNT(*) AS n, AVG(result_tokens) AS avg_t,
                 MAX(result_tokens) AS max_t
            FROM tool_calls
           WHERE tool_name='_tool_result' AND result_tokens > 50000 AND timestamp >= ?
        """, (since,)).fetchone()
        if big and (big["n"] or 0) >= 5:
            key = _key("tool-bloat", "result-50k+")
            if not _is_dismissed(db_path, key):
                links = _affected_sessions(
                    c,
                    "tool_name='_tool_result' AND result_tokens > 50000 AND timestamp >= ?",
                    [since],
                )
                out.append({
                    "key": key, "category": "tool-bloat",
                    "title": f"{big['n']} tool results over 50k tokens this week",
                    "body": f"Average size is {int(big['avg_t']):,} tokens, with the largest at {int(big['max_t'] or 0):,}. These turns were expensive because oversized tool output was copied into local context.",
                    "scope": "result-50k+",
                    "why": "Large tool results often come from broad searches, full logs, generated files, or unbounded command output.",
                    "rule": "Use narrower paths, grep with context limits, or pipe long output to head/tail before asking the model to reason over it.",
                    "links": links,
                })
        for row in c.execute("""
          SELECT agent_id, COUNT(*) AS n,
                 AVG(input_tokens+output_tokens) AS mean_t,
                 MAX(input_tokens+output_tokens) AS max_t
            FROM messages
           WHERE is_sidechain=1 AND agent_id IS NOT NULL AND timestamp >= ?
           GROUP BY agent_id HAVING n >= 10
        """, (since,)):
            if (row["max_t"] or 0) > 6 * (row["mean_t"] or 1) and (row["max_t"] or 0) > 50_000:
                key = _key("subagent-outlier", row["agent_id"])
                if _is_dismissed(db_path, key):
                    continue
                out.append({
                    "key": key, "category": "subagent-outlier",
                    "title": f"Subagent {row['agent_id']} has cost outliers",
                    "body": f"Largest invocation used {int(row['max_t']):,} tokens vs mean {int(row['mean_t']):,}. Worth checking what those did differently.",
                    "scope": row["agent_id"],
                })
    return out


def expensive_pattern_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    """Group repeated expensive tool patterns so one noisy workflow is shown once."""
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out = []
    with connect(db_path) as c:
        rows = c.execute("""
          SELECT COALESCE(provider, 'claude') AS provider,
                 project_slug,
                 tool_name,
                 COALESCE(target, '(no target)') AS target_key,
                 COUNT(*) AS calls,
                 COUNT(DISTINCT session_id) AS sessions,
                 SUM(COALESCE(result_tokens, 0)) AS total_result_tokens,
                 MAX(COALESCE(result_tokens, 0)) AS max_result_tokens
            FROM tool_calls
           WHERE timestamp >= ?
             AND COALESCE(result_tokens, 0) > 0
           GROUP BY provider, project_slug, tool_name, target_key
          HAVING calls >= 3 AND total_result_tokens >= 75000
           ORDER BY total_result_tokens DESC
           LIMIT 10
        """, (since,)).fetchall()
        for row in rows:
            scope = f"{row['provider']}:{row['project_slug']}:{row['tool_name']}:{row['target_key']}"
            key = _key("expensive-pattern", scope)
            if _is_dismissed(db_path, key):
                continue
            links = _affected_sessions(
                c,
                "timestamp >= ? AND COALESCE(provider, 'claude') = ? AND project_slug = ? AND tool_name = ? AND COALESCE(target, '(no target)') = ?",
                [since, row["provider"], row["project_slug"], row["tool_name"], row["target_key"]],
            )
            out.append({
                "key": key,
                "category": "expensive-pattern",
                "provider": row["provider"],
                "title": f"{row['tool_name']} on {row['target_key']} returned {int(row['total_result_tokens'] or 0):,} tokens",
                "body": f"This repeated pattern appeared {row['calls']} times across {row['sessions']} sessions in {row['project_slug']}. It was expensive because the same kind of tool output kept being fed back into context.",
                "scope": row["target_key"],
                "why": f"Largest single result was {int(row['max_result_tokens'] or 0):,} tokens.",
                "rule": "Turn repeated expensive discoveries into a local note or narrower command so future sessions do not rediscover the same bulk output.",
                "links": links,
                "signal": "repeated-expensive-tool-output",
            })
    return out


def doctor_edit_thrashing_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    """Doctor-style signal: one file edited repeatedly in a session."""
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out = []
    with connect(db_path) as c:
        for row in c.execute(f"""
          SELECT session_id, project_slug, provider, target, COUNT(*) AS edits
            FROM tool_calls
           WHERE timestamp >= ?
             AND target IS NOT NULL
             AND {EDIT_TOOL_SQL}
           GROUP BY session_id, project_slug, provider, target
          HAVING edits >= 5
           ORDER BY edits DESC
           LIMIT 10
        """, (since,)):
            provider = row["provider"] or "claude"
            label = _provider_label(provider)
            key = _key("doctor-edit-thrashing", f"{provider}:{row['session_id']}:{row['target']}")
            if _is_dismissed(db_path, key):
                continue
            out.append({
                "key": key,
                "category": "doctor",
                "provider": provider,
                "title": f"{label}: {row['target']} edited {row['edits']} times in one session",
                "body": f"Doctor-style analysis flags 5+ edits to the same file as edit thrashing. In {row['project_slug']}, this session likely needed a fuller read and one complete edit plan before touching the file again.",
                "scope": row["session_id"],
                "why": "Repeated edits usually mean the agent kept rediscovering constraints after each patch, which burns tokens on more reads, diffs, and retries.",
                "rule": "Read the full file before editing. Plan all changes, then make one complete edit.",
                "links": [_session_link(row["session_id"], provider), *_affected_prompts(c, row["session_id"], provider, limit=2)],
                "signal": "edit-thrashing",
                "severity": "high" if (row["edits"] or 0) >= 10 else "medium",
            })
    return out


def doctor_error_loop_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    """Doctor-style signal: 3+ consecutive tool errors in a session."""
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out = []
    seen = set()
    with connect(db_path) as c:
        rows = c.execute("""
          SELECT session_id, project_slug, provider, tool_name, target, is_error, timestamp, id
            FROM tool_calls
           WHERE timestamp >= ?
           ORDER BY session_id, timestamp, id
        """, (since,)).fetchall()

    current_session = None
    failures: List[dict] = []

    def flush_failures() -> None:
        if len(failures) < 3:
            return
        first = failures[0]
        provider = first["provider"] or "claude"
        label = _provider_label(provider)
        scope = f"{provider}:{first['session_id']}:{first['timestamp']}:{first['tool_name']}"
        key = _key("doctor-error-loop", scope)
        if key in seen or _is_dismissed(db_path, key):
            return
        seen.add(key)
        tool = first["tool_name"] or "tool"
        out.append({
            "key": key,
            "category": "doctor",
            "provider": provider,
            "title": f"{label}: {len(failures)} consecutive {tool} failures",
            "body": f"Doctor-style analysis treats 3+ consecutive tool failures as an error loop. In {first['project_slug']}, the agent kept retrying without enough strategy change.",
            "scope": first["session_id"],
            "rule": "After 2 consecutive tool failures, stop and change approach entirely before retrying.",
            "signal": "error-loop",
            "severity": "critical" if len(failures) >= 5 else "high",
        })

    for row in rows:
        if row["session_id"] != current_session:
            flush_failures()
            current_session = row["session_id"]
            failures = []
        if row["is_error"]:
            failures.append(dict(row))
        else:
            flush_failures()
            failures = []
    flush_failures()
    return out[:10]


def doctor_exploration_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    """Doctor-style signal: high read-to-edit ratio or read-only wandering."""
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out = []
    with connect(db_path) as c:
        rows = c.execute(f"""
          SELECT session_id, project_slug, provider,
                 SUM(CASE WHEN {READ_TOOL_SQL} THEN 1 ELSE 0 END) AS reads,
                 SUM(CASE WHEN {EDIT_TOOL_SQL} THEN 1 ELSE 0 END) AS edits
            FROM tool_calls
           WHERE timestamp >= ?
           GROUP BY session_id, project_slug, provider
          HAVING reads > 0
           ORDER BY reads DESC
           LIMIT 100
        """, (since,)).fetchall()
    for row in rows:
        reads = row["reads"] or 0
        edits = row["edits"] or 0
        provider = row["provider"] or "claude"
        label_prefix = f"{_provider_label(provider)}: "
        if edits > 0:
            ratio = reads / edits
            if ratio < 10:
                continue
            label = f"read-to-edit ratio was {ratio:.1f}:1"
            body = f"This session in {row['project_slug']} made {reads} read/search calls before or around {edits} edits. Doctor-style analysis flags 10:1 or higher as excessive exploration."
            rule = "Act sooner: read enough to understand the change, make the edit, then iterate from verification."
            signal = "excessive-exploration"
        elif reads > 20:
            label = f"{reads} read/search calls with no edits"
            body = f"This session in {row['project_slug']} explored heavily without editing. Doctor-style analysis treats long read-only sessions as a sign the agent may be stuck or unclear on the next action."
            rule = "When exploration is not converging, summarize what is known and choose the smallest useful next action."
            signal = "read-only-session"
        else:
            continue
        key = _key(f"doctor-{signal}", f"{provider}:{row['session_id']}")
        if _is_dismissed(db_path, key):
            continue
        out.append({
            "key": key,
            "category": "doctor",
            "provider": provider,
            "title": f"{label_prefix}Session {label}",
            "body": body,
            "scope": row["session_id"],
            "why": "Read/search calls are not bad by themselves; they become expensive when the same session keeps gathering context without converging on a change.",
            "rule": rule,
            "links": [_session_link(row["session_id"], provider)],
            "signal": signal,
            "severity": "high" if (edits and reads / edits >= 20) or reads >= 40 else "medium",
        })
    return out[:10]


def doctor_abandonment_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    """Doctor-style signal: many short sessions for a project."""
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out = []
    with connect(db_path) as c:
        rows = c.execute("""
          SELECT project_slug, provider,
                 COUNT(*) AS sessions,
                 SUM(CASE WHEN user_turns < 3 THEN 1 ELSE 0 END) AS short_sessions
            FROM (
              SELECT project_slug, provider, session_id,
                     SUM(CASE WHEN type='user' AND prompt_text IS NOT NULL THEN 1 ELSE 0 END) AS user_turns
                FROM messages
               WHERE timestamp >= ?
               GROUP BY project_slug, provider, session_id
            )
           GROUP BY project_slug, provider
          HAVING sessions >= 3 AND short_sessions >= 3
           ORDER BY short_sessions DESC
           LIMIT 10
        """, (since,)).fetchall()
    for row in rows:
        sessions = row["sessions"] or 0
        short_sessions = row["short_sessions"] or 0
        ratio = short_sessions / sessions if sessions else 0
        if ratio < 0.30:
            continue
        provider = row["provider"] or "claude"
        label = _provider_label(provider)
        key = _key("doctor-high-abandonment-rate", f"{provider}:{row['project_slug']}")
        if _is_dismissed(db_path, key):
            continue
        out.append({
            "key": key,
            "category": "doctor",
            "provider": provider,
            "title": f"{label}: {short_sessions}/{sessions} sessions in {row['project_slug']} ended quickly",
            "body": f"Doctor-style analysis flags projects where many sessions have fewer than 3 user turns. That pattern often means restarts, false starts, or abandoned attempts.",
            "scope": row["project_slug"],
            "rule": "When a session starts wobbling, summarize what happened and continue deliberately instead of restarting.",
            "signal": "high-abandonment-rate",
            "severity": "critical" if ratio >= 0.50 else "high",
        })
    return out


def _session_message_groups(db_path, since: str) -> Tuple[Dict[str, List[dict]], Dict[str, int]]:
    user_messages: Dict[str, List[dict]] = {}
    assistant_counts: Dict[str, int] = {}
    with connect(db_path) as c:
        rows = c.execute("""
          SELECT session_id, project_slug, provider, type, timestamp, prompt_text
            FROM messages
           WHERE timestamp >= ? AND type IN ('user', 'assistant')
           ORDER BY session_id, timestamp
        """, (since,)).fetchall()
    for row in rows:
        sid = row["session_id"]
        if row["type"] == "assistant":
            assistant_counts[sid] = assistant_counts.get(sid, 0) + 1
        elif row["prompt_text"]:
            user_messages.setdefault(sid, []).append(dict(row))
    return user_messages, assistant_counts


def doctor_behavior_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    """Doctor-style user-behavior signals derived from prompt text."""
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    user_messages, assistant_counts = _session_message_groups(db_path, since)
    out = []
    for session_id, rows in user_messages.items():
        if not rows:
            continue
        project = rows[0]["project_slug"]
        provider = rows[0].get("provider") or "claude"
        label = _provider_label(provider)
        texts = [r["prompt_text"] or "" for r in rows]
        correction_count = sum(1 for text in texts if CORRECTION_RE.search(text))
        correction_rate = correction_count / len(texts)
        if correction_count >= 2 and correction_rate > 0.20:
            key = _key("doctor-correction-heavy", f"{provider}:{session_id}")
            if not _is_dismissed(db_path, key):
                out.append({
                    "key": key,
                    "category": "doctor",
                    "provider": provider,
                    "title": f"{label}: {correction_count}/{len(texts)} user turns were corrections",
                    "body": f"In {project}, the user repeatedly corrected or redirected the agent. Doctor-style analysis treats this as a sign the agent should slow down and re-read the ask.",
                    "scope": session_id,
                    "rule": "When the user corrects you, stop and re-read their message before continuing.",
                    "signal": "correction-heavy",
                    "severity": "critical" if correction_rate > 0.40 else "high",
                })

        keep_going_count = sum(1 for text in texts if KEEP_GOING_RE.search(text))
        if keep_going_count >= 2:
            key = _key("doctor-keep-going-loop", f"{provider}:{session_id}")
            if not _is_dismissed(db_path, key):
                out.append({
                    "key": key,
                    "category": "doctor",
                    "provider": provider,
                    "title": f"{label}: User said keep going {keep_going_count} times",
                    "body": f"In {project}, repeated continuation prompts suggest the agent may have stopped before the task was actually complete.",
                    "scope": session_id,
                    "rule": "Complete the full task before stopping, including verification when it matters.",
                    "signal": "keep-going-loop",
                    "severity": "high" if keep_going_count >= 4 else "medium",
                })

        repetitions = 0
        for i, text in enumerate(texts):
            for other in texts[i + 1:i + 5]:
                if _jaccard(text, other) >= 0.60:
                    repetitions += 1
        if repetitions >= 2:
            key = _key("doctor-repeated-instructions", f"{provider}:{session_id}")
            if not _is_dismissed(db_path, key):
                out.append({
                    "key": key,
                    "category": "doctor",
                    "provider": provider,
                    "title": f"{label}: User repeated similar instructions {repetitions} times",
                    "body": f"In {project}, repeated instructions usually mean the agent missed or only partially followed the request.",
                    "scope": session_id,
                    "rule": "Re-read the user's latest message and make sure every instruction is carried through.",
                    "signal": "repeated-instructions",
                    "severity": "critical" if repetitions >= 4 else "high",
                })

        assistant_turns = assistant_counts.get(session_id, 0)
        if assistant_turns and len(texts) >= 5:
            ratio = len(texts) / assistant_turns
            if ratio > 1.5:
                key = _key("doctor-high-turn-ratio", f"{provider}:{session_id}")
                if not _is_dismissed(db_path, key):
                    out.append({
                        "key": key,
                        "category": "doctor",
                        "provider": provider,
                        "title": f"{label}: User-to-assistant turn ratio was {ratio:.1f}:1",
                        "body": f"In {project}, the user had to send unusually many messages per assistant turn, which often indicates repeated steering or correction.",
                        "scope": session_id,
                        "rule": "Work more autonomously once the goal is clear, and verify before handing back.",
                        "signal": "high-turn-ratio",
                        "severity": "high" if ratio > 2.5 else "medium",
                    })
    return out[:10]


def doctor_rapid_followup_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    """Doctor-style signal: fast user follow-ups after assistant turns."""
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out = []
    with connect(db_path) as c:
        rows = c.execute("""
          SELECT session_id, project_slug, provider, type, timestamp, prompt_text
            FROM messages
           WHERE timestamp >= ? AND type IN ('user', 'assistant')
           ORDER BY session_id, timestamp
        """, (since,)).fetchall()
    current_session = None
    previous = None
    fast_counts: Dict[str, dict] = {}
    for row in rows:
        row = dict(row)
        if row["session_id"] != current_session:
            current_session = row["session_id"]
            previous = None
        if (
            previous
            and previous["type"] == "assistant"
            and row["type"] == "user"
            and row.get("prompt_text")
        ):
            prev_ts = _parse_ts(previous["timestamp"])
            cur_ts = _parse_ts(row["timestamp"])
            if prev_ts and cur_ts:
                delta = (cur_ts - prev_ts).total_seconds()
                if 0 < delta < 10:
                    info = fast_counts.setdefault(row["session_id"], {
                        "count": 0,
                        "project_slug": row["project_slug"],
                        "provider": row.get("provider") or "claude",
                    })
                    info["count"] += 1
        previous = row
    for session_id, info in fast_counts.items():
        if info["count"] < 3:
            continue
        provider = info.get("provider") or "claude"
        label = _provider_label(provider)
        key = _key("doctor-rapid-corrections", f"{provider}:{session_id}")
        if _is_dismissed(db_path, key):
            continue
        out.append({
            "key": key,
            "category": "doctor",
            "provider": provider,
            "title": f"{label}: {info['count']} rapid user follow-ups after assistant replies",
            "body": f"In {info['project_slug']}, the user responded within 10 seconds several times. Doctor-style analysis treats that as a hint the answer was immediately incomplete or off-target.",
            "scope": session_id,
            "rule": "Double-check the output against the request before presenting it.",
            "signal": "rapid-corrections",
            "severity": "high" if info["count"] >= 5 else "medium",
        })
    return out[:10]


def doctor_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    """Doctor-inspired quality tips over the same 7-day window."""
    return [
        *doctor_edit_thrashing_tips(db_path, today_iso),
        *doctor_error_loop_tips(db_path, today_iso),
        *doctor_exploration_tips(db_path, today_iso),
        *doctor_abandonment_tips(db_path, today_iso),
        *doctor_behavior_tips(db_path, today_iso),
        *doctor_rapid_followup_tips(db_path, today_iso),
    ]


def all_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    return [
        *cache_discipline_tips(db_path, today_iso),
        *repeated_target_tips(db_path, today_iso),
        *right_size_tips(db_path, today_iso),
        *outlier_tips(db_path, today_iso),
        *expensive_pattern_tips(db_path, today_iso),
        *doctor_tips(db_path, today_iso),
    ]
