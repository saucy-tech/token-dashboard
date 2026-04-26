import os
import sqlite3
import tempfile
import unittest
from token_dashboard.db import init_db, connect, recent_prompts, recent_sessions, health_check, DBLockedError, vacuum_dismissed_tips


class InitDbTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "test.db")

    def test_init_creates_expected_tables(self):
        init_db(self.db_path)
        with sqlite3.connect(self.db_path) as c:
            tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        expected = {
            "files", "messages", "tool_calls", "plan", "dismissed_tips",
            "usage_snapshots", "usage_snapshot_meta",
        }
        self.assertTrue(expected.issubset(tables), f"Missing: {expected - tables}")

    def test_init_is_idempotent(self):
        init_db(self.db_path)
        init_db(self.db_path)

    def test_connect_returns_row_factory(self):
        init_db(self.db_path)
        with connect(self.db_path) as c:
            r = c.execute("SELECT 1 AS one").fetchone()
        self.assertEqual(r["one"], 1)

    def test_health_check_reports_ok_for_valid_db(self):
        init_db(self.db_path)
        status = health_check(self.db_path)
        self.assertTrue(status["ok"])
        self.assertEqual(status["checks"]["quick_check"], "ok")

    def test_health_check_flags_corrupt_db(self):
        with open(self.db_path, "wb") as f:
            f.write(b"not-a-sqlite-db")
        status = health_check(self.db_path)
        self.assertFalse(status["ok"])
        self.assertEqual(status["checks"]["quick_check"], "error")


class OffsetQueryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "offsets.db")
        init_db(self.db_path)
        with sqlite3.connect(self.db_path) as c:
            c.execute(
                "INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, prompt_text, prompt_chars) "
                "VALUES ('u1', NULL, 's1', 'proj', 'claude', 'user', '2026-04-19T00:00:00Z', NULL, 0, 0, 0, 0, 0, 'prompt 1', 8)"
            )
            c.execute(
                "INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) "
                "VALUES ('a1', 'u1', 's1', 'proj', 'claude', 'assistant', '2026-04-19T00:00:01Z', 'claude-haiku-4-5', 5, 5, 0, 0, 0)"
            )
            c.execute(
                "INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, prompt_text, prompt_chars) "
                "VALUES ('u2', NULL, 's2', 'proj', 'claude', 'user', '2026-04-19T00:01:00Z', NULL, 0, 0, 0, 0, 0, 'prompt 2', 8)"
            )
            c.execute(
                "INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) "
                "VALUES ('a2', 'u2', 's2', 'proj', 'claude', 'assistant', '2026-04-19T00:01:01Z', 'claude-haiku-4-5', 10, 10, 0, 0, 0)"
            )
            c.execute(
                "INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, prompt_text, prompt_chars) "
                "VALUES ('u3', NULL, 's3', 'proj', 'claude', 'user', '2026-04-19T00:02:00Z', NULL, 0, 0, 0, 0, 0, 'prompt 3', 8)"
            )
            c.execute(
                "INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) "
                "VALUES ('a3', 'u3', 's3', 'proj', 'claude', 'assistant', '2026-04-19T00:02:01Z', 'claude-haiku-4-5', 15, 15, 0, 0, 0)"
            )
            c.commit()

    def test_recent_sessions_offset(self):
        first = recent_sessions(self.db_path, limit=1, offset=0)
        second = recent_sessions(self.db_path, limit=1, offset=1)
        self.assertEqual([row["session_id"] for row in first], ["s3"])
        self.assertEqual([row["session_id"] for row in second], ["s2"])

    def test_recent_prompts_offset(self):
        first = recent_prompts(self.db_path, limit=1, offset=0)
        second = recent_prompts(self.db_path, limit=1, offset=1)
        self.assertEqual([row["session_id"] for row in first], ["s3"])
        self.assertEqual([row["session_id"] for row in second], ["s2"])


class TestDBLockedError(unittest.TestCase):
    def test_import(self):
        # DBLockedError must be importable from db
        self.assertTrue(issubclass(DBLockedError, Exception))


class TestVacuumDismissedTips(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_vacuum_removes_old_tips(self):
        with sqlite3.connect(self.db) as c:
            c.execute("INSERT INTO dismissed_tips VALUES ('old_tip', strftime('%s','now','-31 days'))")
            c.execute("INSERT INTO dismissed_tips VALUES ('new_tip', strftime('%s','now','-1 days'))")
            c.commit()
        vacuum_dismissed_tips(self.db)
        with sqlite3.connect(self.db) as c:
            rows = c.execute("SELECT tip_key FROM dismissed_tips").fetchall()
        keys = [r[0] for r in rows]
        self.assertNotIn('old_tip', keys)
        self.assertIn('new_tip', keys)

    def test_vacuum_no_crash_empty(self):
        vacuum_dismissed_tips(self.db)


if __name__ == "__main__":
    unittest.main()
