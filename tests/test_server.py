import http.server
import json
import os
import socket
import sqlite3
import tempfile
import threading
import unittest
import urllib.request

from token_dashboard.db import init_db
from token_dashboard.server import build_handler


def _free_port():
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)
        with sqlite3.connect(self.db) as c:
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, prompt_text, prompt_chars) VALUES ('u',NULL,'s','p','claude','user','2026-04-19T00:00:00Z',NULL,0,0,0,0,0,'hi',2)")
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('a','u','s','p','claude','assistant','2026-04-19T00:00:01Z','claude-haiku-4-5',1,1,0,0,0)")
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, prompt_text, prompt_chars) VALUES ('u2',NULL,'s2','p2','codex','user','2026-04-19T00:01:00Z',NULL,0,0,0,0,0,'yo',2)")
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('a2','u2','s2','p2','codex','assistant','2026-04-19T00:01:01Z','claude-haiku-4-5',2,3,0,0,0)")
            c.commit()
        try:
            self.port = _free_port()
        except PermissionError as e:
            raise unittest.SkipTest(f"socket bind unavailable in sandbox: {e}")
        H = build_handler(self.db, projects_dir="/nonexistent")
        self.httpd = http.server.HTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()

    def _get(self, path):
        return urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}").read()

    def test_index_html(self):
        body = self._get("/")
        self.assertIn(b"Agent Dashboard", body)

    def test_overview_json(self):
        body = json.loads(self._get("/api/overview"))
        self.assertIn("sessions", body)
        self.assertEqual(body["sessions"], 2)
        self.assertFalse(body["cost_partial"])

    def test_overview_json_can_filter_provider(self):
        body = json.loads(self._get("/api/overview?provider=codex"))
        self.assertEqual(body["sessions"], 1)
        self.assertEqual(body["turns"], 1)

    def test_prompts_json(self):
        body = json.loads(self._get("/api/prompts?limit=10"))
        self.assertIsInstance(body, list)

    def test_prompts_json_can_filter_provider(self):
        body = json.loads(self._get("/api/prompts?limit=10&provider=codex"))
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["provider"], "codex")

    def test_export_prompts_csv(self):
        body = self._get("/api/export/prompts.csv?limit=10&provider=codex").decode("utf-8")
        self.assertIn("prompt_text", body)
        self.assertIn("small", body)
        self.assertIn("codex", body)

    def test_projects_json(self):
        body = json.loads(self._get("/api/projects"))
        self.assertIsInstance(body, list)
        self.assertEqual({row["project_slug"] for row in body}, {"p", "p2"})

    def test_projects_json_can_filter_provider(self):
        body = json.loads(self._get("/api/projects?provider=claude"))
        self.assertEqual([row["project_slug"] for row in body], ["p"])

    def test_export_projects_json(self):
        body = json.loads(self._get("/api/export/projects.json?provider=claude"))
        self.assertEqual([row["project_slug"] for row in body], ["p"])

    def test_export_sessions_csv(self):
        body = self._get("/api/export/sessions.csv?provider=claude").decode("utf-8")
        self.assertIn("session_id", body)
        self.assertIn("s", body)

    def test_plan_json(self):
        body = json.loads(self._get("/api/plan"))
        self.assertIn("plan", body)
        self.assertIn("pricing", body)

    def test_providers_json(self):
        body = json.loads(self._get("/api/providers"))
        self.assertIsInstance(body, list)
        providers = {row["provider"] for row in body}
        self.assertEqual(providers, {"claude", "codex"})

    def test_sources_json(self):
        body = json.loads(self._get("/api/sources"))
        self.assertIn("sources", body)
        by_provider = {row["provider"]: row for row in body["sources"]}
        self.assertEqual(by_provider["claude"]["status"], "missing")
        self.assertEqual(by_provider["claude"]["cached_sessions"], 1)
        self.assertEqual(by_provider["codex"]["status"], "disabled")

    def test_head_returns_200_not_501(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/", method="HEAD")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.read(), b"")

    def test_head_api_endpoint(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/overview", method="HEAD")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.read(), b"")


if __name__ == "__main__":
    unittest.main()
