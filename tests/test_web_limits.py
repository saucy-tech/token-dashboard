import subprocess
import unittest
from pathlib import Path


class WebLimitTests(unittest.TestCase):
    def test_limit_math_js_module(self):
        root = Path(__file__).resolve().parent.parent
        try:
            result = subprocess.run(
                ["node", "tests/js/limits_test.mjs"],
                cwd=root,
                text=True,
                capture_output=True,
                check=False,
            )
        except FileNotFoundError as e:
            raise unittest.SkipTest(f"node unavailable: {e}")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)


if __name__ == "__main__":
    unittest.main()
