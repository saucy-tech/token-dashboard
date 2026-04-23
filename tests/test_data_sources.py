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
        self.assertEqual(by_provider["claude"]["log_files"], 1)
        self.assertEqual(by_provider["codex"]["status"], "missing")
        self.assertFalse(status["all_connected"])
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
        self.assertEqual(by_provider["claude"]["cached_sessions"], 1)
        self.assertEqual(by_provider["codex"]["status"], "empty")


if __name__ == "__main__":
    unittest.main()
