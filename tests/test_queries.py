import os
import tempfile
import unittest

from token_dashboard.db import (
    init_db, connect,
    overview_totals, expensive_prompts, project_summary,
    tool_token_breakdown, recent_sessions, session_turns,
    daily_token_breakdown, model_breakdown, project_name_for,
    provider_breakdown, skill_breakdown, ensure_usage_snapshots,
    snapshot_rollups, snapshot_dimension_rows, current_session,
)


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "q.db")
        init_db(self.db)
        with connect(self.db) as c:
            c.executescript("""
            INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model,
              input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens,
              prompt_text, prompt_chars)
            VALUES
              ('u1',NULL,'s1','projA','claude','user','2026-04-10T00:00:00Z',NULL,0,0,0,0,0,'big prompt',10),
              ('a1','u1','s1','projA','claude','assistant','2026-04-10T00:00:01Z','claude-opus-4-7',100,200,300,0,0,NULL,NULL),
              ('u2',NULL,'s2','projB','codex','user','2026-04-11T00:00:00Z',NULL,0,0,0,0,0,'small',5),
              ('a2','u2','s2','projB','codex','assistant','2026-04-11T00:00:01Z','claude-sonnet-4-6',5,5,0,0,0,NULL,NULL);
            INSERT INTO tool_calls (message_uuid, session_id, project_slug, provider, tool_name, target, timestamp, is_error)
            VALUES ('a1','s1','projA','claude','Read','foo.py','2026-04-10T00:00:01Z',0),
                   ('a1','s1','projA','claude','Bash','npm test','2026-04-10T00:00:01Z',0),
                   ('a2','s2','projB','codex','Write','bar.py','2026-04-11T00:00:01Z',0);
            """)
            c.commit()

    def test_overview_totals(self):
        t = overview_totals(self.db, since=None, until=None)
        self.assertEqual(t["sessions"], 2)
        self.assertEqual(t["turns"], 2)
        self.assertEqual(t["input_tokens"], 105)
        self.assertEqual(t["output_tokens"], 205)

    def test_overview_totals_can_filter_provider(self):
        t = overview_totals(self.db, provider="codex")
        self.assertEqual(t["sessions"], 1)
        self.assertEqual(t["turns"], 1)
        self.assertEqual(t["input_tokens"], 5)
        self.assertEqual(t["output_tokens"], 5)

    def test_expensive_prompts_orders_by_tokens(self):
        rows = expensive_prompts(self.db, limit=10)
        self.assertGreaterEqual(len(rows), 2)
        self.assertEqual(rows[0]["prompt_text"], "big prompt")
        self.assertIn("why_expensive", rows[0])
        self.assertIn("cost_drivers", rows[0])

    def test_expensive_prompts_explains_tool_result_drivers(self):
        with connect(self.db) as c:
            c.execute("UPDATE tool_calls SET result_tokens=60000 WHERE message_uuid='a1' AND tool_name='Read'")
            c.execute("INSERT INTO tool_calls (message_uuid, session_id, project_slug, provider, tool_name, target, result_tokens, timestamp, is_error) VALUES ('a1','s1','projA','claude','Read','foo.py',1000,'2026-04-10T00:00:02Z',0)")
            c.commit()
        row = expensive_prompts(self.db, limit=10)[0]
        self.assertIn("oversized tool result", row["why_expensive"])
        self.assertIn("repeated read/search", row["why_expensive"])
        self.assertEqual(row["cost_drivers"][0]["tool_name"], "Read")

    def test_expensive_prompts_sort_recent(self):
        rows = expensive_prompts(self.db, limit=10, sort="recent")
        self.assertEqual(rows[0]["prompt_text"], "small")
        self.assertEqual(rows[1]["prompt_text"], "big prompt")

    def test_expensive_prompts_can_filter_provider(self):
        rows = expensive_prompts(self.db, limit=10, provider="codex")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["provider"], "codex")
        self.assertEqual(rows[0]["prompt_text"], "small")

    def test_project_summary_groups(self):
        rows = project_summary(self.db)
        slugs = {r["project_slug"]: r for r in rows}
        self.assertIn("projA", slugs)
        self.assertEqual(slugs["projA"]["turns"], 1)

    def test_project_summary_can_filter_provider(self):
        rows = project_summary(self.db, provider="codex")
        self.assertEqual([r["project_slug"] for r in rows], ["projB"])

    def test_tool_breakdown(self):
        rows = tool_token_breakdown(self.db)
        names = {r["tool_name"]: r for r in rows}
        self.assertIn("Read", names)
        self.assertIn("Bash", names)

    def test_tool_breakdown_can_filter_provider(self):
        rows = tool_token_breakdown(self.db, provider="codex")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["tool_name"], "Write")

    def test_recent_sessions(self):
        rows = recent_sessions(self.db, limit=5)
        self.assertEqual(rows[0]["session_id"], "s2")

    def test_recent_sessions_can_filter_provider(self):
        rows = recent_sessions(self.db, limit=5, provider="claude")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["session_id"], "s1")
        self.assertEqual(rows[0]["billable_tokens"], 300)

    def test_current_session_uses_latest_session_rollup(self):
        row = current_session(self.db)
        self.assertEqual(row["session_id"], "s2")
        self.assertEqual(row["started_at"], "2026-04-11T00:00:00Z")
        self.assertEqual(row["ended_at"], "2026-04-11T00:00:01Z")
        self.assertEqual(row["provider"], "codex")
        self.assertEqual(row["billable_tokens"], 10)
        self.assertEqual(row["primary_model"], "claude-sonnet-4-6")
        self.assertEqual(row["models"][0]["billable_tokens"], 10)

    def test_current_session_can_filter_provider(self):
        row = current_session(self.db, provider="claude")
        self.assertEqual(row["session_id"], "s1")
        self.assertEqual(row["is_current"], 1)

    def test_current_session_ignores_future_sessions(self):
        with connect(self.db) as c:
            c.execute("INSERT INTO messages (uuid, session_id, project_slug, provider, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('future','future','projA','claude','assistant','2999-01-01T00:00:00Z','claude-opus-4-7',1000,1000,0,0,0)")
            c.commit()
        row = current_session(self.db, provider="claude")
        self.assertEqual(row["session_id"], "s1")

    def test_session_attribution_sums_only_matching_session_id(self):
        with connect(self.db) as c:
            c.executescript("""
            INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, provider, type, timestamp, model,
              input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens)
            VALUES
              ('u3',NULL,'s1','projA','claude','user','2026-04-12T00:00:00Z',NULL,0,0,0,0,0),
              ('a3','u3','s1','projA','claude','assistant','2026-04-12T00:00:01Z','claude-opus-4-7',7,11,13,17,19),
              ('u4',NULL,'s-other','projA','claude','user','2026-04-13T00:00:00Z',NULL,0,0,0,0,0),
              ('a4','u4','s-other','projA','claude','assistant','2026-04-13T00:00:01Z','claude-opus-4-7',1000,1000,0,0,0);
            """)
            c.commit()

        rows = {row["session_id"]: row for row in recent_sessions(self.db, limit=10, provider="claude")}

        self.assertEqual(rows["s1"]["input_tokens"], 107)
        self.assertEqual(rows["s1"]["output_tokens"], 211)
        self.assertEqual(rows["s1"]["cache_read_tokens"], 313)
        self.assertEqual(rows["s1"]["billable_tokens"], 354)
        self.assertEqual(rows["s1"]["started"], "2026-04-10T00:00:00Z")
        self.assertEqual(rows["s1"]["ended"], "2026-04-12T00:00:01Z")

    def test_session_turns(self):
        rows = session_turns(self.db, "s1")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["tool_calls"], [])
        self.assertEqual([t["tool_name"] for t in rows[1]["tool_calls"]], ["Read", "Bash"])
        self.assertEqual(rows[1]["tool_calls"][0]["target"], "foo.py")

    def test_daily_token_breakdown_groups_by_day(self):
        rows = daily_token_breakdown(self.db)
        days = {r["day"]: r for r in rows}
        self.assertIn("2026-04-10", days)
        self.assertIn("2026-04-11", days)
        self.assertEqual(days["2026-04-10"]["input_tokens"], 100)
        self.assertEqual(days["2026-04-10"]["output_tokens"], 200)
        self.assertEqual(days["2026-04-10"]["cache_read_tokens"], 300)

    def test_daily_token_breakdown_respects_since(self):
        rows = daily_token_breakdown(self.db, since="2026-04-11T00:00:00Z")
        days = [r["day"] for r in rows]
        self.assertEqual(days, ["2026-04-11"])

    def test_daily_token_breakdown_can_filter_provider(self):
        rows = daily_token_breakdown(self.db, provider="codex")
        self.assertEqual([r["day"] for r in rows], ["2026-04-11"])
        self.assertEqual(rows[0]["input_tokens"], 5)

    def test_model_breakdown_respects_since_and_groups(self):
        rows = model_breakdown(self.db)
        models = {r["model"]: r for r in rows}
        self.assertIn("claude-opus-4-7", models)
        self.assertIn("claude-sonnet-4-6", models)
        self.assertEqual(models["claude-opus-4-7"]["input_tokens"], 100)

        filtered = model_breakdown(self.db, since="2026-04-11T00:00:00Z")
        names = [r["model"] for r in filtered]
        self.assertEqual(names, ["claude-sonnet-4-6"])

    def test_model_breakdown_can_filter_provider(self):
        rows = model_breakdown(self.db, provider="codex")
        self.assertEqual([r["model"] for r in rows], ["claude-sonnet-4-6"])

    def test_provider_breakdown_lists_each_provider(self):
        rows = provider_breakdown(self.db)
        by_provider = {r["provider"]: r for r in rows}
        self.assertEqual(by_provider["claude"]["sessions"], 1)
        self.assertEqual(by_provider["codex"]["sessions"], 1)

    def test_provider_breakdown_can_filter_provider(self):
        rows = provider_breakdown(self.db, provider="codex")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["provider"], "codex")

    def test_usage_snapshots_cache_weekly_rollups(self):
        first = ensure_usage_snapshots(self.db)
        second = ensure_usage_snapshots(self.db)

        self.assertTrue(first["rebuilt"])
        self.assertFalse(second["rebuilt"])
        rows = snapshot_rollups(self.db, period="week", limit=4)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["start_date"], "2026-04-06")
        self.assertEqual(rows[0]["sessions"], 2)
        self.assertEqual(
            rows[0]["input_tokens"] + rows[0]["output_tokens"],
            310,
        )

    def test_usage_snapshots_keep_project_and_model_series(self):
        ensure_usage_snapshots(self.db)

        projects = snapshot_dimension_rows(self.db, "project", "week")
        models = snapshot_dimension_rows(self.db, "model", "week", provider="codex")

        by_project = {row["dimension_key"]: row for row in projects}
        self.assertEqual(by_project["projA"]["dimension_label"], "projA")
        self.assertEqual(by_project["projB"]["sessions"], 1)
        self.assertEqual([row["dimension_key"] for row in models], ["claude-sonnet-4-6"])


class SkillBreakdownTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "s.db")
        init_db(self.db)
        with connect(self.db) as c:
            c.executescript("""
            INSERT INTO messages (uuid, session_id, project_slug, type, timestamp)
            VALUES
              ('u1','s1','pA','user','2026-04-10T00:00:00Z'),
              ('a1','s1','pA','assistant','2026-04-10T00:00:01Z'),
              ('u2','s2','pA','user','2026-04-11T00:00:00Z'),
              ('a2','s2','pA','assistant','2026-04-11T00:00:01Z');

            INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, result_tokens, timestamp, is_error)
            VALUES
              ('a1','s1','pA','Skill','brainstorming',NULL,'2026-04-10T00:00:01Z',0),
              ('u1','s1','pA','_tool_result','use-123',500,'2026-04-10T00:00:05Z',0),
              ('a1','s1','pA','Skill','brainstorming',NULL,'2026-04-10T00:00:30Z',0),
              ('a1','s1','pA','Task','superpowers:brainstorming',NULL,'2026-04-10T00:00:40Z',0),
              ('u1','s1','pA','_tool_result','use-124',800,'2026-04-10T00:00:32Z',0),
              ('a2','s2','pA','Skill','create-skill',NULL,'2026-04-11T00:00:01Z',0),
              ('a2','s2','pA','Task','code-reviewer',NULL,'2026-04-11T00:00:03Z',0),
              ('u2','s2','pA','_tool_result','use-125',1200,'2026-04-11T00:00:02Z',0);
            """)
            c.commit()

    def test_groups_by_skill(self):
        rows = skill_breakdown(self.db)
        by_name = {r["skill"]: r for r in rows}
        self.assertEqual(by_name["brainstorming"]["invocations"], 2)
        self.assertEqual(by_name["brainstorming"]["sessions"], 1)
        self.assertEqual(by_name["superpowers:brainstorming"]["invocations"], 1)
        self.assertEqual(by_name["create-skill"]["invocations"], 1)
        self.assertNotIn("code-reviewer", by_name)

    def test_orders_by_invocations(self):
        rows = skill_breakdown(self.db)
        self.assertEqual(rows[0]["skill"], "brainstorming")

    def test_respects_since(self):
        rows = skill_breakdown(self.db, since="2026-04-11T00:00:00Z")
        names = [r["skill"] for r in rows]
        self.assertEqual(names, ["create-skill"])


class ProjectNameTests(unittest.TestCase):
    def test_basename_of_posix_cwd(self):
        self.assertEqual(project_name_for("/Users/x/foo", "slug"), "foo")

    def test_basename_of_windows_cwd(self):
        self.assertEqual(
            project_name_for(r"C:\Users\alice\projects\Token Dashboard", "anything"),
            "Token Dashboard",
        )

    def test_trailing_slash_stripped(self):
        self.assertEqual(project_name_for("/a/b/c/", "slug"), "c")

    def test_fallback_uses_last_dash_segment(self):
        self.assertEqual(
            project_name_for(None, "C--Users-x-Foo-Bar"),
            "Bar",
        )

    def test_fallback_single_segment(self):
        self.assertEqual(project_name_for(None, "projA"), "projA")

    def test_empty(self):
        self.assertEqual(project_name_for(None, ""), "")

    def test_walks_up_cwd_to_project_root(self):
        # cwd is a subfolder; slug matches the parent → return the parent's basename
        self.assertEqual(
            project_name_for(
                r"C:\Users\alice\projects\MyProject\subdir",
                "C--Users-alice-projects-MyProject",
            ),
            "MyProject",
        )

    def test_walks_up_preserves_spaces(self):
        self.assertEqual(
            project_name_for(
                r"C:\Users\alice\projects\Token Dashboard\src\subdir",
                "C--Users-alice-projects-Token-Dashboard",
            ),
            "Token Dashboard",
        )


class ProjectNameInQueriesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "n.db")
        init_db(self.db)
        with connect(self.db) as c:
            c.executescript("""
            INSERT INTO messages (uuid, session_id, project_slug, cwd, type, timestamp,
              input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens)
            VALUES
              ('u1','s1','C--Users-x-My-Repo','/Users/x/My Repo','user','2026-04-10T00:00:00Z',0,0,0,0,0),
              ('a1','s1','C--Users-x-My-Repo','/Users/x/My Repo','assistant','2026-04-10T00:00:01Z',10,20,0,0,0),
              ('u2','s2','slugOnly',NULL,'user','2026-04-11T00:00:00Z',0,0,0,0,0),
              ('a2','s2','slugOnly',NULL,'assistant','2026-04-11T00:00:01Z',5,5,0,0,0);
            """)
            c.commit()

    def test_project_summary_uses_cwd_basename(self):
        rows = project_summary(self.db)
        names = {r["project_slug"]: r["project_name"] for r in rows}
        self.assertEqual(names["C--Users-x-My-Repo"], "My Repo")
        self.assertEqual(names["slugOnly"], "slugOnly")

    def test_recent_sessions_has_project_name(self):
        rows = recent_sessions(self.db)
        by_sid = {r["session_id"]: r for r in rows}
        self.assertEqual(by_sid["s1"]["project_name"], "My Repo")
        self.assertEqual(by_sid["s2"]["project_name"], "slugOnly")


if __name__ == "__main__":
    unittest.main()
