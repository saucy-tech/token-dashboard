import os
import sqlite3
import tempfile
import unittest

from token_dashboard.db import (
    init_db,
    overview_totals,
    set_usage_limit_settings,
    usage_limit_settings,
)


class UsageSettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_usage_limit_settings_round_trip_and_validation(self):
        saved = set_usage_limit_settings(self.db, {
            "session_tokens": "128000",
            "hourly_tokens": "400000",
            "weekly_tokens": "1000000",
            "weekly_enabled": False,
            "week_start_day": 8,
            "caution_pct": 95,
            "near_pct": 80,
            "active_session_window_minutes": 0,
            "providers": {
                "claude": {"session_tokens": 200000, "hourly_tokens": 250000, "weekly_tokens": 3000000},
                "codex": {"session_tokens": -1, "hourly_tokens": -1, "weekly_tokens": 500000},
            },
        })

        self.assertEqual(saved["session_tokens"], 128000)
        self.assertEqual(saved["hourly_tokens"], 400000)
        self.assertEqual(saved["weekly_tokens"], 1000000)
        self.assertFalse(saved["weekly_enabled"])
        self.assertEqual(saved["week_start_day"], 6)
        self.assertLess(saved["caution_pct"], saved["near_pct"])
        self.assertEqual(saved["active_session_window_minutes"], 1)
        self.assertEqual(saved["providers"]["claude"]["hourly_tokens"], 250000)
        self.assertIsNone(saved["providers"]["codex"]["hourly_tokens"])
        self.assertEqual(saved["providers"]["claude"]["weekly_tokens"], 3000000)
        self.assertIsNone(saved["providers"]["codex"]["session_tokens"])
        self.assertEqual(usage_limit_settings(self.db), saved)

    def test_browser_iso_week_window_filters_backend_totals(self):
        with sqlite3.connect(self.db) as c:
            rows = [
                ("before", "2026-03-08T04:59:59Z", 10),
                ("inside", "2026-03-08T05:00:00Z", 20),
                ("after", "2026-03-15T04:00:00Z", 30),
            ]
            for uuid, ts, tokens in rows:
                c.execute(
                    "INSERT INTO messages (uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (uuid, uuid, "p", "claude", "assistant", ts, "claude-haiku-4-5", tokens, 0, 0, 0, 0),
                )
            c.commit()

        totals = overview_totals(
            self.db,
            since="2026-03-08T05:00:00.000Z",
            until="2026-03-15T04:00:00.000Z",
        )
        self.assertEqual(totals["sessions"], 1)
        self.assertEqual(totals["input_tokens"], 20)


if __name__ == "__main__":
    unittest.main()
