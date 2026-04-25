import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from token_dashboard.db import init_db
from token_dashboard.scanner import data_source_status


class DataSourceStatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_reports_connected_and_missing_sources(self):
        claude_root = Path(self.tmp) / "claude" / "projects"
        (claude_root / "demo").mkdir(parents=True)
        (claude_root / "demo" / "s.jsonl").write_text("{}\n", encoding="utf-8")

        status = data_source_status(
            claude_root,
            Path(self.tmp) / "missing-codex",
            self.db,
        )

        by_provider = {s["provider"]: s for s in status["sources"]}
        self.assertEqual(by_provider["claude"]["status"], "connected")
        self.assertEqual(by_provider["claude"]["data_state"], "not_scanned")
        self.assertEqual(by_provider["claude"]["log_files"], 1)
        self.assertEqual(by_provider["claude"]["scanned_files"], 0)
        self.assertEqual(by_provider["codex"]["status"], "missing")
        self.assertFalse(status["all_connected"])
        self.assertFalse(status["data_complete"])
        self.assertEqual(status["missing"], ["codex"])

    def test_reports_empty_root_and_cache_counts(self):
        codex_home = Path(self.tmp) / ".codex"
        (codex_home / "sessions").mkdir(parents=True)
        with sqlite3.connect(self.db) as c:
            c.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, provider, type, timestamp) "
                "VALUES ('u', 's', 'p', 'claude', 'user', '2026-04-19T00:00:00Z')"
            )
            c.commit()

        status = data_source_status(Path(self.tmp) / "empty-claude", codex_home, self.db)

        by_provider = {s["provider"]: s for s in status["sources"]}
        self.assertEqual(by_provider["claude"]["status"], "missing")
        self.assertEqual(by_provider["claude"]["data_state"], "cached_missing")
        self.assertEqual(by_provider["claude"]["cached_sessions"], 1)
        self.assertEqual(by_provider["codex"]["status"], "empty")
        self.assertEqual(by_provider["codex"]["data_state"], "empty")

    def test_reports_ready_when_logs_are_scanned_and_cached(self):
        claude_root = Path(self.tmp) / "claude" / "projects"
        log_path = claude_root / "demo" / "s.jsonl"
        log_path.parent.mkdir(parents=True)
        log_path.write_text("{}\n", encoding="utf-8")
        stat = log_path.stat()
        with sqlite3.connect(self.db) as c:
            c.execute(
                "INSERT INTO files (path, mtime, bytes_read, scanned_at) VALUES (?, ?, ?, ?)",
                (str(log_path), stat.st_mtime, stat.st_size, stat.st_mtime),
            )
            c.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, provider, type, timestamp) "
                "VALUES ('u', 's', 'p', 'claude', 'user', '2026-04-19T00:00:00Z')"
            )
            c.commit()

        status = data_source_status(claude_root, None, self.db)

        by_provider = {s["provider"]: s for s in status["sources"]}
        self.assertEqual(by_provider["claude"]["data_state"], "ready")
        self.assertEqual(by_provider["claude"]["scanned_files"], 1)
        self.assertTrue(status["data_complete"])

    def test_disabled_source_with_cache_is_marked_cached_disabled(self):
        with sqlite3.connect(self.db) as c:
            c.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, provider, type, timestamp) "
                "VALUES ('u-codex', 's-codex', 'p', 'codex', 'user', '2026-04-19T00:00:00Z')"
            )
            c.commit()

        status = data_source_status(Path(self.tmp) / "missing-claude", None, self.db)
        by_provider = {s["provider"]: s for s in status["sources"]}
        self.assertEqual(by_provider["codex"]["status"], "disabled")
        self.assertEqual(by_provider["codex"]["data_state"], "cached_disabled")
        self.assertIn("claude", status["missing"])
        self.assertIn("claude", status["incomplete"])


if __name__ == "__main__":
    unittest.main()
