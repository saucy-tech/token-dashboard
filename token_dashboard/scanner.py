"""Transcript scanners for Claude and Codex."""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union

from .db import connect


INSERT_MSG = """
INSERT OR REPLACE INTO messages (
  uuid, parent_uuid, session_id, project_slug, provider, session_label, cwd, git_branch, cc_version, entrypoint,
  type, is_sidechain, agent_id, timestamp, model, stop_reason, prompt_id, message_id,
  input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens,
  prompt_text, prompt_chars, tool_calls_json
) VALUES (
  :uuid, :parent_uuid, :session_id, :project_slug, :provider, :session_label, :cwd, :git_branch, :cc_version, :entrypoint,
  :type, :is_sidechain, :agent_id, :timestamp, :model, :stop_reason, :prompt_id, :message_id,
  :input_tokens, :output_tokens, :cache_read_tokens, :cache_create_5m_tokens, :cache_create_1h_tokens,
  :prompt_text, :prompt_chars, :tool_calls_json
)
"""

INSERT_TOOL = """
INSERT INTO tool_calls (message_uuid, session_id, project_slug, provider, tool_name, target, result_tokens, is_error, timestamp)
VALUES (:message_uuid, :session_id, :project_slug, :provider, :tool_name, :target, :result_tokens, :is_error, :timestamp)
"""


_TARGET_FIELDS = {
    "Read": "file_path",
    "Edit": "file_path",
    "Write": "file_path",
    "Glob": "pattern",
    "Grep": "pattern",
    "Bash": "command",
    "WebFetch": "url",
    "WebSearch": "query",
    "Task": "subagent_type",
    "Skill": "skill",
}


def _usage(rec: dict) -> dict:
    u = (rec.get("message") or {}).get("usage") or {}
    cc = u.get("cache_creation") or {}
    return {
        "input_tokens": int(u.get("input_tokens") or 0),
        "output_tokens": int(u.get("output_tokens") or 0),
        "cache_read_tokens": int(u.get("cache_read_input_tokens") or 0),
        "cache_create_5m_tokens": int(cc.get("ephemeral_5m_input_tokens") or 0),
        "cache_create_1h_tokens": int(cc.get("ephemeral_1h_input_tokens") or 0),
    }


def _prompt_text(rec: dict) -> Tuple[Optional[str], Optional[int]]:
    if rec.get("type") != "user":
        return None, None
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, str):
        return content, len(content)
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        text = "".join(parts) if parts else None
        return text, (len(text) if text else None)
    return None, None


def _target(name: str, inp: dict) -> Optional[str]:
    field = _TARGET_FIELDS.get(name)
    if field and isinstance(inp, dict):
        v = inp.get(field)
        if isinstance(v, str):
            return v[:500]
    return None


def _extract_tools(rec: dict) -> List[dict]:
    out = []
    content = (rec.get("message") or {}).get("content")
    if not isinstance(content, list):
        return out
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name = block.get("name") or "unknown"
        target = _target(name, block.get("input") or {})
        out.append({
            "tool_name": name,
            "target": target,
            "result_tokens": None,
            "is_error": 0,
            "timestamp": rec.get("timestamp"),
        })
    return out


def _extract_results(rec: dict) -> List[dict]:
    out = []
    content = (rec.get("message") or {}).get("content")
    if not isinstance(content, list):
        return out
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        out.append({
            "tool_name": "_tool_result",
            "target": block.get("tool_use_id"),
            "result_tokens": _result_token_estimate(block.get("content")),
            "is_error": 1 if block.get("is_error") else 0,
            "timestamp": rec.get("timestamp"),
        })
    return out


def parse_record(rec: dict, project_slug: str) -> Tuple[dict, List[dict]]:
    """Parse a Claude JSONL record into one message row plus any tool rows."""
    msg_obj = rec.get("message") or {}
    text, chars = _prompt_text(rec)
    msg = {
        "uuid": rec.get("uuid"),
        "parent_uuid": rec.get("parentUuid"),
        "session_id": rec.get("sessionId"),
        "project_slug": project_slug,
        "provider": "claude",
        "session_label": None,
        "cwd": rec.get("cwd"),
        "git_branch": rec.get("gitBranch"),
        "cc_version": rec.get("version"),
        "entrypoint": rec.get("entrypoint"),
        "type": rec.get("type"),
        "is_sidechain": 1 if rec.get("isSidechain") else 0,
        "agent_id": rec.get("agentId"),
        "timestamp": rec.get("timestamp"),
        "model": msg_obj.get("model"),
        "stop_reason": msg_obj.get("stop_reason"),
        "prompt_id": rec.get("promptId"),
        "message_id": msg_obj.get("id"),
        "prompt_text": text,
        "prompt_chars": chars,
        "tool_calls_json": None,
        **_usage(rec),
    }
    tools = _extract_tools(rec)
    tools.extend(_extract_results(rec))
    if tools:
        msg["tool_calls_json"] = json.dumps(
            [{"name": t["tool_name"], "target": t["target"]} for t in tools if t["tool_name"] != "_tool_result"]
        )
    for t in tools:
        t["message_uuid"] = msg["uuid"]
        t["session_id"] = msg["session_id"]
        t["project_slug"] = project_slug
        t["provider"] = "claude"
    return msg, tools


def _project_slug(file_path: Path, projects_root: Path) -> str:
    rel = file_path.relative_to(projects_root)
    return rel.parts[0]


def _evict_prior_snapshots(conn, session_id: str, message_id: str, keep_uuid: str) -> None:
    """Remove older Claude streaming snapshots for the same response."""
    old = [r[0] for r in conn.execute(
        "SELECT uuid FROM messages WHERE session_id=? AND message_id=? AND uuid!=?",
        (session_id, message_id, keep_uuid),
    )]
    if not old:
        return
    placeholders = ",".join("?" * len(old))
    conn.execute(f"DELETE FROM tool_calls WHERE message_uuid IN ({placeholders})", old)
    conn.execute(f"DELETE FROM messages WHERE uuid IN ({placeholders})", old)


def scan_file(path: Path, project_slug: str, conn, start_byte: int = 0) -> dict:
    """Incrementally ingest a Claude JSONL file."""
    msgs = tools = 0
    end_offset = start_byte
    with open(path, "rb") as fb:
        if start_byte:
            fb.seek(start_byte)
        while True:
            raw = fb.readline()
            if not raw:
                break
            if not raw.endswith(b"\n"):
                break
            line_end = fb.tell()
            try:
                line = raw.decode("utf-8", errors="replace").strip()
            except Exception:
                end_offset = line_end
                continue
            if not line:
                end_offset = line_end
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                end_offset = line_end
                continue
            if not isinstance(rec, dict) or "uuid" not in rec or "type" not in rec:
                end_offset = line_end
                continue
            msg, tlist = parse_record(rec, project_slug)
            if not msg["session_id"] or not msg["timestamp"]:
                end_offset = line_end
                continue
            if msg["message_id"]:
                _evict_prior_snapshots(conn, msg["session_id"], msg["message_id"], msg["uuid"])
            conn.execute(INSERT_MSG, msg)
            conn.execute("DELETE FROM tool_calls WHERE message_uuid=?", (msg["uuid"],))
            for t in tlist:
                conn.execute(INSERT_TOOL, t)
                tools += 1
            msgs += 1
            end_offset = line_end
    return {"messages": msgs, "tools": tools, "end_offset": end_offset}


def scan_dir(projects_root: Union[str, Path], db_path: Union[str, Path]) -> dict:
    """Scan Claude project transcripts from ~/.claude/projects."""
    root = Path(projects_root)
    totals = {"messages": 0, "tools": 0, "files": 0}
    if not root.is_dir():
        return totals
    with connect(db_path) as conn:
        for p in root.rglob("*.jsonl"):
            try:
                stat = p.stat()
            except OSError:
                continue
            row = conn.execute(
                "SELECT mtime, bytes_read FROM files WHERE path=?", (str(p),)
            ).fetchone()
            offset = 0
            if row and row["mtime"] == stat.st_mtime and row["bytes_read"] == stat.st_size:
                continue
            if row and row["mtime"] <= stat.st_mtime and row["bytes_read"] < stat.st_size:
                offset = int(row["bytes_read"])
            n = scan_file(p, _project_slug(p, root), conn, start_byte=offset)
            conn.execute(
                "INSERT OR REPLACE INTO files (path, mtime, bytes_read, scanned_at) VALUES (?,?,?,?)",
                (str(p), stat.st_mtime, n["end_offset"], time.time()),
            )
            totals["messages"] += n["messages"]
            totals["tools"] += n["tools"]
            totals["files"] += 1
        conn.commit()
    return totals


def scan_sources(
    claude_projects_root: Optional[Union[str, Path]],
    db_path: Union[str, Path],
    codex_home: Optional[Union[str, Path]] = None,
) -> dict:
    totals = {"messages": 0, "tools": 0, "files": 0}
    if claude_projects_root:
        n = scan_dir(claude_projects_root, db_path)
        totals["messages"] += n["messages"]
        totals["tools"] += n["tools"]
        totals["files"] += n["files"]
    if codex_home:
        n = scan_codex_home(codex_home, db_path)
        totals["messages"] += n["messages"]
        totals["tools"] += n["tools"]
        totals["files"] += n["files"]
    return totals


def _result_token_estimate(body) -> int:
    if isinstance(body, str):
        chars = len(body)
    elif isinstance(body, list):
        chars = sum(len(p.get("text", "")) for p in body if isinstance(p, dict))
    elif body is None:
        chars = 0
    else:
        chars = len(json.dumps(body, ensure_ascii=False))
    return chars // 4


def _codex_raw_session_id(path: Path) -> str:
    stem = path.stem
    return stem[-36:] if len(stem) >= 36 else stem


def _codex_session_key(raw_session_id: str) -> str:
    return f"codex:{raw_session_id}"


def _slug_from_cwd(cwd: Optional[str], fallback: str) -> str:
    if not cwd:
        return fallback
    return re.sub(r"[:\\/ ]", "-", cwd)


def _coerce_text(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except TypeError:
        return str(value)


def _truncate(value: Optional[str], limit: int = 500) -> Optional[str]:
    if value is None:
        return None
    return value[:limit]


def _parse_json_object(raw: Optional[str]) -> Optional[dict]:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def _codex_patch_target(raw: Optional[str]) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    for pattern in (
        r"^\*\*\* Update File: (.+)$",
        r"^\*\*\* Add File: (.+)$",
        r"^\*\*\* Delete File: (.+)$",
    ):
        m = re.search(pattern, raw, flags=re.MULTILINE)
        if m:
            return _truncate(m.group(1))
    return None


def _codex_tool_target(name: str, args: Optional[dict], raw: Optional[str]) -> Optional[str]:
    if name == "exec_command" and args:
        return _truncate(_coerce_text(args.get("cmd")))
    if name == "apply_patch":
        return _codex_patch_target(raw) or _truncate("apply_patch")
    if name == "parallel" and args:
        tools = args.get("tool_uses")
        if isinstance(tools, list):
            names = []
            for tool in tools:
                if isinstance(tool, dict) and tool.get("recipient_name"):
                    names.append(str(tool["recipient_name"]).split(".")[-1])
            if names:
                return _truncate(", ".join(names))
    if args:
        for key in ("path", "cmd", "message", "url", "query", "title", "prompt", "value", "target"):
            if key in args:
                text = _coerce_text(args.get(key))
                if text:
                    return _truncate(text)
    return _truncate(raw) if raw else None


def _result_error_flag(raw: Optional[str]) -> int:
    text = raw or ""
    if not isinstance(text, str):
        return 0
    lowered = text.lower()
    if '"iserror":true' in lowered or '"status":"failed"' in lowered:
        return 1
    if "process exited with code 0" in lowered:
        return 0
    return 1 if "process exited with code " in lowered else 0


def _codex_rows_from_records(records: List[dict], session_labels: Dict[str, str], file_path: Path) -> Tuple[Optional[str], List[Tuple[dict, List[dict]]]]:
    session_meta = {}
    for rec in records:
        if rec.get("type") == "session_meta" and isinstance(rec.get("payload"), dict):
            session_meta = rec["payload"]
            break

    raw_session_id = session_meta.get("id") or _codex_raw_session_id(file_path)
    if not raw_session_id:
        return None, []

    session_id = _codex_session_key(raw_session_id)
    session_label = session_labels.get(raw_session_id)
    session_cwd = session_meta.get("cwd")
    cli_version = session_meta.get("cli_version")
    source = session_meta.get("source")

    turns: Dict[str, dict] = {}
    order: List[str] = []
    current_turn_id = None
    anon_turns = 0

    def turn_for(turn_id: Optional[str] = None) -> dict:
        nonlocal current_turn_id, anon_turns
        use_id = turn_id or current_turn_id
        if not use_id:
            anon_turns += 1
            use_id = f"anon-{anon_turns}"
            current_turn_id = use_id
        if use_id not in turns:
            turns[use_id] = {
                "turn_id": use_id,
                "prompt_text": None,
                "user_ts": None,
                "assistant_ts": None,
                "last_usage_ts": None,
                "model": None,
                "cwd": None,
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "tool_calls": [],
                "tool_results": [],
            }
            order.append(use_id)
        return turns[use_id]

    for rec in records:
        ts = rec.get("timestamp")
        kind = rec.get("type")
        payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}

        if kind == "session_meta":
            if payload.get("cwd"):
                session_cwd = payload["cwd"]
            if payload.get("cli_version"):
                cli_version = payload["cli_version"]
            if payload.get("source"):
                source = payload["source"]
            continue

        if kind == "turn_context":
            current_turn_id = payload.get("turn_id") or current_turn_id
            turn = turn_for(payload.get("turn_id"))
            if payload.get("model"):
                turn["model"] = payload["model"]
            if payload.get("cwd"):
                turn["cwd"] = payload["cwd"]
            continue

        if kind == "event_msg":
            ptype = payload.get("type")
            if ptype == "thread_name_updated" and payload.get("thread_name"):
                session_label = payload["thread_name"]
            elif ptype == "task_started":
                current_turn_id = payload.get("turn_id") or current_turn_id
                turn_for(payload.get("turn_id"))
            elif ptype == "user_message":
                turn = turn_for()
                turn["prompt_text"] = payload.get("message")
                turn["user_ts"] = ts
            elif ptype == "token_count" and payload.get("info"):
                usage = payload["info"].get("last_token_usage") or {}
                if usage:
                    turn = turn_for()
                    turn["input_tokens"] += int(usage.get("input_tokens") or 0)
                    turn["output_tokens"] += int(usage.get("output_tokens") or 0)
                    turn["cache_read_tokens"] += int(usage.get("cached_input_tokens") or 0)
                    turn["last_usage_ts"] = ts
            elif ptype == "task_complete":
                turn = turn_for(payload.get("turn_id"))
                turn["assistant_ts"] = ts
            continue

        if kind != "response_item" or not payload:
            continue

        ptype = payload.get("type")
        if ptype == "message" and payload.get("role") == "assistant":
            turn = turn_for()
            turn["assistant_ts"] = ts
            continue

        if ptype in ("function_call", "custom_tool_call"):
            turn = turn_for()
            raw = payload.get("arguments") if ptype == "function_call" else payload.get("input")
            args = _parse_json_object(raw)
            turn["tool_calls"].append({
                "call_id": payload.get("call_id"),
                "tool_name": payload.get("name") or "tool",
                "target": _codex_tool_target(payload.get("name") or "tool", args, raw),
                "result_tokens": None,
                "is_error": 0,
                "timestamp": ts,
            })
            continue

        if ptype in ("function_call_output", "custom_tool_call_output"):
            turn = turn_for()
            raw = payload.get("output")
            turn["tool_results"].append({
                "tool_name": "_tool_result",
                "target": payload.get("call_id"),
                "result_tokens": _result_token_estimate(raw),
                "is_error": _result_error_flag(raw),
                "timestamp": ts,
            })

    rows: List[Tuple[dict, List[dict]]] = []
    for turn_id in order:
        turn = turns[turn_id]
        cwd = turn["cwd"] or session_cwd
        project_slug = _slug_from_cwd(cwd, raw_session_id)
        user_uuid = f"codex:{raw_session_id}:{turn_id}:user"
        assistant_uuid = f"codex:{raw_session_id}:{turn_id}:assistant"
        user_msg = {
            "uuid": user_uuid,
            "parent_uuid": None,
            "session_id": session_id,
            "project_slug": project_slug,
            "provider": "codex",
            "session_label": session_label,
            "cwd": _coerce_text(cwd),
            "git_branch": None,
            "cc_version": _coerce_text(cli_version),
            "entrypoint": _coerce_text(source),
            "type": "user",
            "is_sidechain": 0,
            "agent_id": None,
            "timestamp": turn["user_ts"] or turn["assistant_ts"] or turn["last_usage_ts"] or session_meta.get("timestamp"),
            "model": None,
            "stop_reason": None,
            "prompt_id": turn_id,
            "message_id": turn_id,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_create_5m_tokens": 0,
            "cache_create_1h_tokens": 0,
            "prompt_text": turn["prompt_text"],
            "prompt_chars": len(turn["prompt_text"]) if turn["prompt_text"] else None,
            "tool_calls_json": None,
        }
        assistant_tools = turn["tool_calls"] + turn["tool_results"]
        assistant_msg = {
            "uuid": assistant_uuid,
            "parent_uuid": user_uuid,
            "session_id": session_id,
            "project_slug": project_slug,
            "provider": "codex",
            "session_label": session_label,
            "cwd": _coerce_text(cwd),
            "git_branch": None,
            "cc_version": _coerce_text(cli_version),
            "entrypoint": _coerce_text(source),
            "type": "assistant",
            "is_sidechain": 0,
            "agent_id": None,
            "timestamp": turn["assistant_ts"] or turn["last_usage_ts"] or turn["user_ts"] or session_meta.get("timestamp"),
            "model": turn["model"],
            "stop_reason": None,
            "prompt_id": turn_id,
            "message_id": turn_id,
            "input_tokens": turn["input_tokens"],
            "output_tokens": turn["output_tokens"],
            "cache_read_tokens": turn["cache_read_tokens"],
            "cache_create_5m_tokens": 0,
            "cache_create_1h_tokens": 0,
            "prompt_text": None,
            "prompt_chars": None,
            "tool_calls_json": None,
        }
        if assistant_tools:
            assistant_msg["tool_calls_json"] = json.dumps([
                {"name": t["tool_name"], "target": t["target"]}
                for t in assistant_tools
                if t["tool_name"] != "_tool_result"
            ])

        tool_rows = []
        for tool in assistant_tools:
            tool_rows.append({
                "message_uuid": assistant_uuid,
                "session_id": session_id,
                "project_slug": project_slug,
                "provider": "codex",
                "tool_name": tool["tool_name"],
                "target": tool["target"],
                "result_tokens": tool["result_tokens"],
                "is_error": tool["is_error"],
                "timestamp": tool["timestamp"] or assistant_msg["timestamp"],
            })
        rows.append((user_msg, []))
        if assistant_msg["timestamp"] or assistant_tools or assistant_msg["input_tokens"] or assistant_msg["output_tokens"]:
            rows.append((assistant_msg, tool_rows))

    return session_id, rows


def _load_codex_session_labels(codex_home: Path) -> Dict[str, str]:
    labels: Dict[str, str] = {}
    idx = codex_home / "session_index.jsonl"
    if not idx.is_file():
        return labels
    for rec in _iter_jsonl_records(idx):
        if not isinstance(rec, dict):
            continue
        sid = rec.get("id")
        label = rec.get("thread_name")
        if sid and label:
            labels[str(sid)] = str(label)
    return labels


def _iter_jsonl_records(path: Path) -> List[dict]:
    records: List[dict] = []
    with open(path, "rb") as fb:
        while True:
            raw = fb.readline()
            if not raw:
                break
            if not raw.endswith(b"\n"):
                break
            try:
                line = raw.decode("utf-8", errors="replace").strip()
            except Exception:
                continue
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict):
                records.append(rec)
    return records


def _codex_candidate_paths(codex_home: Path) -> List[Path]:
    by_session: Dict[str, Path] = {}

    def add_paths(root: Path) -> None:
        if not root.is_dir():
            return
        for path in root.rglob("*.jsonl"):
            raw_id = _codex_raw_session_id(path)
            prev = by_session.get(raw_id)
            if prev is None:
                by_session[raw_id] = path
                continue
            try:
                choose = path.stat().st_mtime >= prev.stat().st_mtime
            except OSError:
                choose = False
            if choose:
                by_session[raw_id] = path

    add_paths(codex_home / "sessions")
    add_paths(codex_home / "archived_sessions")
    return sorted(by_session.values())


def _scan_codex_file(path: Path, conn, session_labels: Dict[str, str]) -> dict:
    records = _iter_jsonl_records(path)
    if not records:
        return {"messages": 0, "tools": 0}

    session_id, rows = _codex_rows_from_records(records, session_labels, path)
    if not session_id:
        return {"messages": 0, "tools": 0}

    conn.execute("DELETE FROM tool_calls WHERE provider='codex' AND session_id=?", (session_id,))
    conn.execute("DELETE FROM messages WHERE provider='codex' AND session_id=?", (session_id,))

    msgs = tools = 0
    for msg, tool_rows in rows:
        if not msg["timestamp"]:
            continue
        conn.execute(INSERT_MSG, msg)
        msgs += 1
        for tool in tool_rows:
            conn.execute(INSERT_TOOL, tool)
            tools += 1
    return {"messages": msgs, "tools": tools}


def scan_codex_home(codex_home: Union[str, Path], db_path: Union[str, Path]) -> dict:
    """Scan Codex active + archived JSONL sessions from ~/.codex."""
    home = Path(codex_home)
    totals = {"messages": 0, "tools": 0, "files": 0}
    if not home.is_dir():
        return totals

    session_labels = _load_codex_session_labels(home)
    with connect(db_path) as conn:
        for path in _codex_candidate_paths(home):
            try:
                stat = path.stat()
            except OSError:
                continue
            row = conn.execute(
                "SELECT mtime, bytes_read FROM files WHERE path=?", (str(path),)
            ).fetchone()
            if row and row["mtime"] == stat.st_mtime and row["bytes_read"] == stat.st_size:
                continue
            n = _scan_codex_file(path, conn, session_labels)
            conn.execute(
                "INSERT OR REPLACE INTO files (path, mtime, bytes_read, scanned_at) VALUES (?,?,?,?)",
                (str(path), stat.st_mtime, stat.st_size, time.time()),
            )
            totals["messages"] += n["messages"]
            totals["tools"] += n["tools"]
            totals["files"] += 1
        conn.commit()
    return totals


def default_codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))
