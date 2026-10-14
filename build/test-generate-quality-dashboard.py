#!/usr/bin/env python3
"""Tests for build/generate-quality-dashboard.py's source-reading helpers.

Run with `python3 build/test-generate-quality-dashboard.py`. The dashboard
generator reads the G# conformance sources by path and by declaration syntax;
the C# to G# cut-over renamed one of them and broke the Docs site build
(#4904), so these pin both the real file and the failure messages.
"""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "generate_quality_dashboard", REPO / "build" / "generate-quality-dashboard.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/generate-quality-dashboard.py")
dashboard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dashboard)


class RandomizedCaseCountTests(unittest.TestCase):
    def write(self, root: Path, text: str) -> None:
        path = root / dashboard.RANDOMIZED_CONFORMANCE_SOURCE
        path.parent.mkdir(parents=True)
        path.write_text(text)

    def test_reads_the_checked_in_source(self) -> None:
        self.assertGreater(dashboard.randomized_case_count(), 0)

    def test_parses_gsharp_const_declaration(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.write(Path(tmp), "type T class {\n    internal const CaseCount int32 = 17\n}\n")
            self.assertEqual(dashboard.randomized_case_count(Path(tmp)), 17)

    def test_ignores_non_declaration_mentions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.write(Path(tmp), "Enumerable.Range(0, CaseCount)\nlet x = CaseCount == 5\n")
            with self.assertRaisesRegex(RuntimeError, "CaseCount"):
                dashboard.randomized_case_count(Path(tmp))

    def test_missing_file_has_clear_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, "RandomizedDriverConformanceTests.gs"):
                dashboard.randomized_case_count(Path(tmp))


if __name__ == "__main__":
    unittest.main()
