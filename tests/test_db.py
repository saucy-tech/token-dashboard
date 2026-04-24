import os
import sqlite3
import tempfile
import unittest
from token_dashboard.db import init_db, connect, recent_prompts, recent_sessions


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


if __name__ == "__main__":
    unittest.main()
