import os
import unittest

from token_dashboard.pricing import load_pricing, cost_for, format_for_user

PRICING = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "pricing.json"))


class CostTests(unittest.TestCase):
    def setUp(self):
        self.p = load_pricing(PRICING)

    def _u(self, **kw):
        base = {
            "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
            "cache_create_5m_tokens": 0, "cache_create_1h_tokens": 0,
        }
        base.update(kw)
        return base

    def test_known_opus_input_cost(self):
        c = cost_for("claude-opus-4-7", self._u(input_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 15.00, places=4)
        self.assertFalse(c["estimated"])

    def test_known_sonnet_output_cost(self):
        c = cost_for("claude-sonnet-4-6", self._u(output_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 15.00, places=4)

    def test_unknown_opus_falls_back(self):
        c = cost_for("claude-opus-9-9-experimental", self._u(input_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 15.00, places=4)
        self.assertTrue(c["estimated"])

    def test_unknown_unparseable_returns_none(self):
        c = cost_for("custom-local-model", self._u(input_tokens=9999), self.p)
        self.assertIsNone(c["usd"])

    def test_cache_read_cheaper_than_input(self):
        c_in = cost_for("claude-opus-4-7", self._u(input_tokens=1_000_000), self.p)
        c_cr = cost_for("claude-opus-4-7", self._u(cache_read_tokens=1_000_000), self.p)
        self.assertLess(c_cr["usd"], c_in["usd"])

    def test_known_codex_gpt_5_4_cost(self):
        c = cost_for("gpt-5.4", self._u(input_tokens=1_000_000, output_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 17.50, places=4)
        self.assertFalse(c["estimated"])

    def test_codex_cached_input_not_double_counted(self):
        c = cost_for("gpt-5.4", self._u(input_tokens=1_000_000, cache_read_tokens=250_000), self.p)
        self.assertAlmostEqual(c["usd"], 1.9375, places=4)
        self.assertAlmostEqual(c["breakdown"]["input"], 1.875, places=4)
        self.assertAlmostEqual(c["breakdown"]["cache_read"], 0.0625, places=4)

    def test_specialized_codex_model_cost(self):
        c = cost_for("gpt-5.3-codex", self._u(output_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 14.00, places=4)
        self.assertFalse(c["estimated"])

    def test_unknown_codex_model_uses_codex_fallback(self):
        c = cost_for("gpt-5.9-codex-preview", self._u(output_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 14.00, places=4)
        self.assertTrue(c["estimated"])

    def test_unknown_openai_model_uses_gpt_fallback(self):
        c = cost_for("gpt-5.9-experimental", self._u(output_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 15.00, places=4)
        self.assertTrue(c["estimated"])

    def test_gpt_prefix_fallback_is_provider_aware(self):
        codex = cost_for(
            "gpt-local-lab-model",
            self._u(output_tokens=1_000_000),
            self.p,
            provider="codex",
        )
        self.assertAlmostEqual(codex["usd"], 15.00, places=4)
        self.assertTrue(codex["estimated"])

        claude = cost_for(
            "gpt-local-lab-model",
            self._u(output_tokens=1_000_000),
            self.p,
            provider="claude",
        )
        self.assertIsNone(claude["usd"])
        self.assertTrue(claude["estimated"])


class PlanFormatTests(unittest.TestCase):
    def setUp(self):
        self.p = load_pricing(PRICING)

    def test_api_plan_returns_raw(self):
        out = format_for_user(12.34, "api", self.p)
        self.assertEqual(out["display_usd"], 12.34)
        self.assertIsNone(out["subscription_usd"])

    def test_pro_plan_returns_subscription_subtitle(self):
        out = format_for_user(12.34, "pro", self.p)
        self.assertEqual(out["subscription_usd"], 20)
        self.assertIn("Pro", out["subtitle"])


if __name__ == "__main__":
    unittest.main()
