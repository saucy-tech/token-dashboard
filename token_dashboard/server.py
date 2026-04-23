"""HTTP server: static frontend + JSON endpoints + SSE diff stream."""
from __future__ import annotations

import http.server
import csv
import io
import json
import mimetypes
import queue
import threading
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, parse_qs

from .db import (
    overview_totals, expensive_prompts, project_summary,
    tool_token_breakdown, recent_sessions, session_turns,
    daily_token_breakdown, model_breakdown, provider_breakdown, skill_breakdown,
)
from .pricing import load_pricing, cost_for, get_plan, set_plan
from .tips import all_tips, dismiss_tip
from .scanner import data_source_status, scan_sources
from .skills import cached_catalog


WEB_ROOT = Path(__file__).resolve().parent.parent / "web"
PRICING_JSON = Path(__file__).resolve().parent.parent / "pricing.json"

EVENTS: "queue.Queue[dict]" = queue.Queue()

MAX_POST_BYTES = 1_000_000  # 1 MB — we only accept tiny JSON bodies (plan, tip key)
MAX_LIMIT = 1000


def _send_json(handler, obj, status: int = 200) -> None:
    body = json.dumps(obj, default=str).encode("utf-8")
    _send_bytes(handler, body, "application/json", status=status)


def _send_bytes(handler, body: bytes, content_type: str, status: int = 200, filename: Optional[str] = None) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    if filename:
        handler.send_header("Content-Disposition", f'attachment; filename="{filename}"')
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)


def _send_error(handler, status: int, msg: str) -> None:
    _send_json(handler, {"error": msg}, status=status)


def _clamp_limit(raw, default: int) -> int:
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(v, MAX_LIMIT))


def _serve_static(handler, rel: str) -> None:
    rel = rel.lstrip("/")
    p = (WEB_ROOT / rel).resolve()
    if not str(p).startswith(str(WEB_ROOT.resolve())) or not p.is_file():
        handler.send_response(404)
        handler.end_headers()
        return
    body = p.read_bytes()
    ctype, _ = mimetypes.guess_type(str(p))
    handler.send_response(200)
    handler.send_header("Content-Type", ctype or "application/octet-stream")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)


def _csv_bytes(rows) -> bytes:
    rows = list(rows or [])
    if rows:
        fieldnames = list(rows[0].keys())
    else:
        fieldnames = []
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    if fieldnames:
        writer.writeheader()
        writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


def _export_rows(handler, rows, filename_base: str, fmt: str) -> None:
    if fmt == "json":
        return _send_bytes(
            handler,
            json.dumps(rows, default=str, indent=2).encode("utf-8"),
            "application/json",
            filename=f"{filename_base}.json",
        )
    if fmt == "csv":
        return _send_bytes(
            handler,
            _csv_bytes(rows),
            "text/csv; charset=utf-8",
            filename=f"{filename_base}.csv",
        )
    return _send_error(handler, 404, "unsupported export format")


def build_handler(db_path: str, projects_dir: str, codex_dir: Optional[str] = None):
    pricing = load_pricing(PRICING_JSON)

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def do_HEAD(self):
            return self.do_GET()

        def do_GET(self):
            url = urlparse(self.path)
            qs = parse_qs(url.query or "")
            path = url.path
            since = qs.get("since", [None])[0]
            until = qs.get("until", [None])[0]
            provider = qs.get("provider", [None])[0]
            if provider in ("", "all"):
                provider = None
            if path in ("/", "/index.html"):
                return _serve_static(self, "index.html")
            if path.startswith("/web/"):
                return _serve_static(self, path[5:])
            if path == "/api/overview":
                totals = overview_totals(db_path, since, until, provider=provider)
                cost_usd = 0.0
                priced = 0
                unpriced = 0
                for m in model_breakdown(db_path, since, until, provider=provider):
                    c = cost_for(m["model"], m, pricing)
                    if c["usd"] is not None:
                        cost_usd += c["usd"]
                        priced += 1
                    else:
                        unpriced += 1
                totals["cost_usd"] = round(cost_usd, 4) if priced else None
                totals["cost_partial"] = unpriced > 0
                totals["unpriced_models"] = unpriced
                return _send_json(self, totals)
            if path.startswith("/api/export/"):
                target = path[len("/api/export/"):]
                if "." not in target:
                    return _send_error(self, 404, "unsupported export target")
                name, fmt = target.rsplit(".", 1)
                limit = _clamp_limit(qs.get("limit", ["100"])[0], 100)
                if name == "prompts":
                    sort = qs.get("sort", ["tokens"])[0]
                    rows = expensive_prompts(db_path, limit=limit, sort=sort, provider=provider)
                    for r in rows:
                        c = cost_for(r["model"], {
                            "input_tokens": 0, "output_tokens": 0,
                            "cache_read_tokens": r["cache_read_tokens"],
                            "cache_create_5m_tokens": 0, "cache_create_1h_tokens": 0,
                        }, pricing)
                        r["estimated_cost_usd"] = c["usd"]
                    return _export_rows(self, rows, "prompts", fmt)
                if name == "projects":
                    return _export_rows(
                        self,
                        project_summary(db_path, since, until, provider=provider),
                        "projects",
                        fmt,
                    )
                if name == "sessions":
                    return _export_rows(
                        self,
                        recent_sessions(
                            db_path,
                            limit=limit,
                            since=since,
                            until=until,
                            provider=provider,
                        ),
                        "sessions",
                        fmt,
                    )
                return _send_error(self, 404, "unsupported export target")
            if path == "/api/prompts":
                limit = _clamp_limit(qs.get("limit", ["50"])[0], 50)
                sort = qs.get("sort", ["tokens"])[0]
                rows = expensive_prompts(db_path, limit=limit, sort=sort, provider=provider)
                for r in rows:
                    c = cost_for(r["model"], {
                        "input_tokens": 0, "output_tokens": 0,
                        "cache_read_tokens": r["cache_read_tokens"],
                        "cache_create_5m_tokens": 0, "cache_create_1h_tokens": 0,
                    }, pricing)
                    r["estimated_cost_usd"] = c["usd"]
                return _send_json(self, rows)
            if path == "/api/projects":
                return _send_json(self, project_summary(db_path, since, until, provider=provider))
            if path == "/api/tools":
                return _send_json(self, tool_token_breakdown(db_path, since, until, provider=provider))
            if path == "/api/sessions":
                return _send_json(self, recent_sessions(
                    db_path, limit=_clamp_limit(qs.get("limit", ["20"])[0], 20),
                    since=since, until=until, provider=provider,
                ))
            if path == "/api/daily":
                return _send_json(self, daily_token_breakdown(db_path, since, until, provider=provider))
            if path == "/api/skills":
                rows = skill_breakdown(db_path, since, until, provider=provider)
                catalog = cached_catalog()
                for r in rows:
                    info = catalog.get(r["skill"])
                    r["tokens_per_call"] = info["tokens"] if info else None
                return _send_json(self, rows)
            if path == "/api/by-model":
                rows = model_breakdown(db_path, since, until, provider=provider)
                for r in rows:
                    c = cost_for(r["model"], r, pricing)
                    r["cost_usd"] = c["usd"]
                    r["cost_estimated"] = c["estimated"]
                return _send_json(self, rows)
            if path == "/api/providers":
                return _send_json(self, provider_breakdown(db_path, since, until, provider=provider))
            if path == "/api/sources":
                return _send_json(self, data_source_status(projects_dir, codex_dir, db_path))
            if path.startswith("/api/sessions/"):
                sid = path.rsplit("/", 1)[1]
                return _send_json(self, session_turns(db_path, sid))
            if path == "/api/tips":
                return _send_json(self, all_tips(db_path))
            if path == "/api/plan":
                return _send_json(self, {"plan": get_plan(db_path), "pricing": pricing})
            if path == "/api/scan":
                n = scan_sources(projects_dir, db_path, codex_home=codex_dir)
                return _send_json(self, n)
            if path == "/api/stream":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                while True:
                    try:
                        evt = EVENTS.get(timeout=15)
                        chunk = f"data: {json.dumps(evt, default=str)}\n\n".encode()
                    except queue.Empty:
                        chunk = b": ping\n\n"
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            url = urlparse(self.path)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return _send_error(self, 400, "invalid Content-Length")
            if length < 0 or length > MAX_POST_BYTES:
                return _send_error(self, 413, f"body too large (max {MAX_POST_BYTES} bytes)")
            try:
                body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except json.JSONDecodeError:
                return _send_error(self, 400, "invalid JSON")
            if not isinstance(body, dict):
                return _send_error(self, 400, "body must be a JSON object")
            if url.path == "/api/plan":
                set_plan(db_path, body.get("plan", "api"))
                return _send_json(self, {"ok": True})
            if url.path == "/api/tips/dismiss":
                dismiss_tip(db_path, body.get("key", ""))
                return _send_json(self, {"ok": True})
            self.send_response(404)
            self.end_headers()

    return H


def _scan_loop(db_path: str, projects_dir: str, codex_dir: Optional[str] = None, interval: float = 30.0):
    while True:
        try:
            n = scan_sources(projects_dir, db_path, codex_home=codex_dir)
            if n["messages"] > 0:
                EVENTS.put({"type": "scan", "n": n, "ts": time.time()})
        except Exception as e:
            EVENTS.put({"type": "error", "message": str(e)})
        time.sleep(interval)


def run(host: str, port: int, db_path: str, projects_dir: str, codex_dir: Optional[str] = None):
    threading.Thread(target=_scan_loop, args=(db_path, projects_dir, codex_dir), daemon=True).start()
    H = build_handler(db_path, projects_dir, codex_dir=codex_dir)
    httpd = http.server.ThreadingHTTPServer((host, port), H)
    httpd.serve_forever()
