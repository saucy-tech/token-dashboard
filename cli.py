"""Token Dashboard CLI entrypoint."""
from __future__ import annotations

import argparse
import os
import webbrowser
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from token_dashboard.db import init_db, default_db_path, overview_totals
from token_dashboard.db import health_check
from token_dashboard.scanner import default_codex_home, scan_sources, data_source_status
from token_dashboard.pricing import load_pricing
from token_dashboard.tips import all_tips


def _db_path(args) -> str:
    return args.db or os.environ.get("TOKEN_DASHBOARD_DB") or str(default_db_path())


def _projects(args) -> str:
    return (
        args.projects_dir
        or os.environ.get("CLAUDE_PROJECTS_DIR")
        or str(Path.home() / ".claude" / "projects")
    )


def _codex(args) -> Optional[str]:
    if getattr(args, "no_codex", False):
        return None
    return args.codex_dir or str(default_codex_home())


def _today_range():
    now = datetime.now(timezone.utc)
    start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc).isoformat()
    end = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    return start, end


def cmd_scan(args):
    db = _db_path(args)
    init_db(db)
    n = scan_sources(_projects(args), db, codex_home=_codex(args))
    print(
        "Token Dashboard: scanned "
        f"{n['files']} files ({n.get('files_seen', 0)} seen), "
        f"{n['messages']} messages, {n['tools']} tool calls, "
        f"{n.get('bytes_read', 0)} bytes in {n.get('elapsed_ms', 0)}ms"
    )


def cmd_today(args):
    db = _db_path(args)
    init_db(db)
    s, e = _today_range()
    t = overview_totals(db, since=s, until=e)
    print("Token Dashboard — today")
    print(f"  sessions: {t['sessions']}    turns: {t['turns']}")
    print(f"  input:    {t['input_tokens']:>12,}    output: {t['output_tokens']:>12,}")
    print(f"  cache rd: {t['cache_read_tokens']:>12,}    cache cr: {t['cache_create_5m_tokens']+t['cache_create_1h_tokens']:>12,}")


def cmd_stats(args):
    db = _db_path(args)
    init_db(db)
    t = overview_totals(db)
    print("Token Dashboard — all time")
    print(f"  sessions: {t['sessions']}    turns: {t['turns']}")
    print(f"  input:    {t['input_tokens']:>12,}    output: {t['output_tokens']:>12,}")


def cmd_tips(args):
    db = _db_path(args)
    init_db(db)
    tips = all_tips(db)
    if not tips:
        print("Token Dashboard: no suggestions")
        return
    for tip in tips:
        print(f"[{tip['category']}] {tip['title']}")
        print(f"  {tip['body']}\n")


def cmd_dashboard(args):
    db = _db_path(args)
    init_db(db)
    if not args.no_scan:
        scan_sources(_projects(args), db, codex_home=_codex(args))
    from token_dashboard.server import run

    host = os.environ.get("HOST", "127.0.0.1")
    port = args.port
    url = f"http://{host}:{port}/"
    if not args.no_open:
        webbrowser.open(url)
    print(f"Token Dashboard listening on {url}")
    run(host, port, db, _projects(args), codex_dir=_codex(args))


def cmd_doctor(args):
    db = _db_path(args)
    db_status = health_check(db)
    if db_status.get("ok"):
        init_db(db)
    sources = data_source_status(_projects(args), _codex(args), db)
    pricing_path = Path(__file__).resolve().parent / "pricing.json"
    pricing = load_pricing(pricing_path)
    known_models = len((pricing.get("models") or {}).keys())

    print("Token Dashboard doctor")
    print(f"  db_ok: {db_status['ok']}")
    print(f"  db_check: {db_status['checks'].get('quick_check')}")
    print(f"  source_connected: {sources['all_connected']}")
    print(f"  source_complete: {sources['data_complete']}")
    print(f"  missing_sources: {', '.join(sources['missing']) if sources['missing'] else 'none'}")
    print(f"  pricing_models: {known_models}")


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", help="SQLite path (default ~/.claude/token-dashboard.db)")
    common.add_argument("--projects-dir", help="JSONL root (default ~/.claude/projects)")
    common.add_argument("--codex-dir", help="Codex home/root (default ~/.codex or $CODEX_HOME)")
    common.add_argument("--no-codex", action="store_true", help="Skip Codex session scanning")

    p = argparse.ArgumentParser(prog="token-dashboard", description="Local Claude Code usage dashboard", parents=[common])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan",  parents=[common]).set_defaults(func=cmd_scan)
    sub.add_parser("today", parents=[common]).set_defaults(func=cmd_today)
    sub.add_parser("stats", parents=[common]).set_defaults(func=cmd_stats)
    sub.add_parser("tips",  parents=[common]).set_defaults(func=cmd_tips)
    sub.add_parser("doctor", parents=[common]).set_defaults(func=cmd_doctor)
    d = sub.add_parser("dashboard", parents=[common])
    d.add_argument("--no-scan", action="store_true")
    d.add_argument("--no-open", action="store_true")
    d.add_argument("--port", type=int, default=8080)
    d.set_defaults(func=cmd_dashboard)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
