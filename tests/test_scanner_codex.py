import json
import os
import sqlite3
import tempfile
import unittest

from token_dashboard.db import init_db
from token_dashboard.scanner import scan_codex_home


class CodexScannerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        self.codex_home = os.path.join(self.tmp, ".codex")
        self.sessions_dir = os.path.join(self.codex_home, "sessions", "2026", "04", "22")
        os.makedirs(self.sessions_dir)
        init_db(self.db)

    def _write_session(self, name: str, records) -> str:
        path = os.path.join(self.sessions_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            for rec in records:
                f.write(json.dumps(rec) + "\n")
        return path

    def test_scans_codex_turns_into_user_and_assistant_rows(self):
        raw_session_id = "019db702-d2ea-7700-87a6-53b2ca5a6699"
        with open(os.path.join(self.codex_home, "session_index.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({
                "id": raw_session_id,
                "thread_name": "Build AI tracker MVP",
                "updated_at": "2026-04-22T21:06:07.761312Z",
            }) + "\n")

        records = [
            {
                "timestamp": "2026-04-22T21:06:00.270Z",
                "type": "session_meta",
                "payload": {
                    "id": raw_session_id,
                    "timestamp": "2026-04-22T21:05:08.853Z",
                    "cwd": "/Users/brandon/Developer/token-dashboard",
                    "cli_version": "0.122.0-alpha.13",
                    "source": "vscode",
                },
            },
            {
                "timestamp": "2026-04-22T21:06:07.755Z",
                "type": "event_msg",
                "payload": {"type": "thread_name_updated", "thread_name": "Build AI tracker MVP"},
            },
            {
                "timestamp": "2026-04-22T21:06:07.760Z",
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-1"},
            },
            {
                "timestamp": "2026-04-22T21:06:07.761Z",
                "type": "turn_context",
                "payload": {
                    "turn_id": "turn-1",
                    "cwd": "/Users/brandon/Developer/token-dashboard",
                    "model": "gpt-5.4",
                },
            },
            {
                "timestamp": "2026-04-22T21:06:07.762Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "Build me an AI tracker MVP",
                },
            },
            {
                "timestamp": "2026-04-22T21:06:08.100Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": json.dumps({"cmd": "ls -la", "workdir": "/Users/brandon/Developer/token-dashboard"}),
                    "call_id": "call-1",
                },
            },
            {
                "timestamp": "2026-04-22T21:06:08.200Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-1",
                    "output": "Chunk ID: abc123\nOutput:\nfile1\nfile2\n",
                },
            },
            {
                "timestamp": "2026-04-22T21:06:09.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 1200,
                            "cached_input_tokens": 400,
                            "output_tokens": 300,
                            "total_tokens": 1500,
                        }
                    },
                },
            },
            {
                "timestamp": "2026-04-22T21:06:10.000Z",
                "type": "event_msg",
                "payload": {"type": "task_complete", "turn_id": "turn-1"},
            },
        ]

        self._write_session(f"rollout-2026-04-22T17-05-08-{raw_session_id}.jsonl", records)

        n = scan_codex_home(self.codex_home, self.db)
        self.assertEqual(n["messages"], 2)
        self.assertEqual(n["tools"], 2)
        self.assertIn("elapsed_ms", n)
        self.assertGreaterEqual(n["bytes_read"], 1)

        with sqlite3.connect(self.db) as c:
            c.row_factory = sqlite3.Row
            messages = c.execute(
                "SELECT session_id, provider, session_label, type, prompt_text, model, input_tokens, output_tokens, cache_read_tokens "
                "FROM messages ORDER BY type ASC"
            ).fetchall()
            tools = c.execute(
                "SELECT provider, tool_name, target FROM tool_calls ORDER BY id ASC"
            ).fetchall()

        self.assertEqual(messages[0]["provider"], "codex")
        self.assertEqual(messages[0]["session_id"], f"codex:{raw_session_id}")
        self.assertEqual(messages[0]["session_label"], "Build AI tracker MVP")
        self.assertEqual(messages[0]["type"], "assistant")
        self.assertEqual(messages[0]["model"], "gpt-5.4")
        self.assertEqual(messages[0]["input_tokens"], 1200)
        self.assertEqual(messages[0]["output_tokens"], 300)
        self.assertEqual(messages[0]["cache_read_tokens"], 400)

        self.assertEqual(messages[1]["type"], "user")
        self.assertEqual(messages[1]["prompt_text"], "Build me an AI tracker MVP")

        self.assertEqual([t["tool_name"] for t in tools], ["exec_command", "_tool_result"])
        self.assertEqual(tools[0]["provider"], "codex")
        self.assertEqual(tools[0]["target"], "ls -la")


if __name__ == "__main__":
    unittest.main()
