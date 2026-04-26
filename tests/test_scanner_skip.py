import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from token_dashboard.db import init_db
from token_dashboard.scanner import scan_file


def _conn(db_path):
    c = sqlite3.connect(db_path)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


class TestScanFileSkips(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)
        self.conn = _conn(self.db)

    def tearDown(self):
        self.conn.close()

    def _write_jsonl(self, lines):
        p = Path(self.tmp) / "test.jsonl"
        with open(p, "w") as f:
            for line in lines:
                f.write(line + "\n")
        return p

    def _valid_record(self, uuid="u1"):
        return json.dumps({
            "uuid": uuid,
            "type": "user",
            "sessionId": "s1",
            "timestamp": "2026-04-26T00:00:00Z",
            "message": {"content": "hello", "usage": {}},
        })

    def test_valid_records_not_counted_as_skipped(self):
        p = self._write_jsonl([self._valid_record("u1"), self._valid_record("u2")])
        result = scan_file(p, "proj", self.conn)
        self.assertEqual(result["skipped"], 0)
        self.assertEqual(result["errors"], [])

    def test_invalid_json_counted_as_skip(self):
        p = self._write_jsonl(["not json at all"])
        result = scan_file(p, "proj", self.conn)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(len(result["errors"]), 1)
        self.assertIn("record_index", result["errors"][0])
        self.assertIn("error", result["errors"][0])

    def test_missing_uuid_counted_as_skip(self):
        bad = json.dumps({"type": "user", "sessionId": "s1", "timestamp": "2026-04-26T00:00:00Z"})
        p = self._write_jsonl([bad])
        result = scan_file(p, "proj", self.conn)
        self.assertEqual(result["skipped"], 1)

    def test_empty_lines_not_counted_as_skipped(self):
        p = self._write_jsonl(["", self._valid_record("u1"), ""])
        result = scan_file(p, "proj", self.conn)
        self.assertEqual(result["skipped"], 0)

    def test_missing_session_id_counted_as_skip(self):
        bad = json.dumps({"uuid": "u1", "type": "user"})  # no sessionId
        p = self._write_jsonl([bad])
        result = scan_file(p, "proj", self.conn)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(result["errors"][0]["error"], "missing session_id or timestamp")

    def test_mixed_valid_and_invalid(self):
        p = self._write_jsonl([
            self._valid_record("u1"),
            "bad json",
            self._valid_record("u2"),
        ])
        result = scan_file(p, "proj", self.conn)
        self.assertEqual(result["messages"], 2)
        self.assertEqual(result["skipped"], 1)


if __name__ == "__main__":
    unittest.main()
