#!/usr/bin/env python3
"""Regression tests for build/selfhost-compare-trx.py (issue #4631, C7)."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("selfhost_compare_trx", REPO / "build" / "selfhost-compare-trx.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/selfhost-compare-trx.py")
trx = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trx)


def write_trx(path: Path, outcomes: dict[str, str]) -> Path:
    results, definitions = [], []
    for index, (name, outcome) in enumerate(outcomes.items()):
        owner, method = name.rsplit(".", 1)
        results.append(f'<UnitTestResult testId="id{index}" testName="{method}" outcome="{outcome}" />')
        definitions.append(f'<UnitTest id="id{index}" name="{method}"><TestMethod className="{owner}" name="{method}" /></UnitTest>')
    path.write_text(
        '<?xml version="1.0" encoding="utf-8"?>'
        '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">'
        f'<Results>{"".join(results)}</Results><TestDefinitions>{"".join(definitions)}</TestDefinitions></TestRun>',
        encoding="utf-8")
    return path


class CompareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_compare(self, baseline: dict[str, str], migrated: dict[str, str]) -> int:
        b = write_trx(self.root / "b.trx", baseline)
        m = write_trx(self.root / "m.trx", migrated)
        with contextlib.redirect_stdout(io.StringIO()):
            return trx.main(["--baseline", str(b), "--migrated", str(m)])

    def test_shared_platform_failures_are_not_regressions(self) -> None:
        both = {f"A.T.Pass{i}": "Passed" for i in range(40)}
        both["A.T.CrlfRawString"] = "Failed"
        self.assertEqual(0, self.run_compare(both, dict(both)))

    def test_a_migrated_only_failure_is_a_regression(self) -> None:
        baseline = {f"A.T.Pass{i}": "Passed" for i in range(40)}
        migrated = dict(baseline, **{"A.T.Pass7": "Failed"})
        self.assertEqual(1, self.run_compare(baseline, migrated))
        report = trx.compare(trx.results(self.root / "b.trx"), trx.results(self.root / "m.trx"), 0.95)
        self.assertEqual(["A.T.Pass7"], report["regressions"])

    def test_a_truncated_run_fails(self) -> None:
        # The deliberately broken input: a test host that died (stack
        # overflow) after a fraction of the suite, with no failures recorded.
        baseline = {f"A.T.Pass{i}": "Passed" for i in range(100)}
        migrated = {f"A.T.Pass{i}": "Passed" for i in range(30)}
        self.assertEqual(1, self.run_compare(baseline, migrated))

    def test_same_method_names_in_different_classes_stay_distinct(self) -> None:
        baseline = {"A.One.Run": "Passed", "A.Two.Run": "Failed"}
        migrated = {"A.One.Run": "Failed", "A.Two.Run": "Passed"}
        report = trx.compare(trx.results(write_trx(self.root / "b.trx", baseline)),
                             trx.results(write_trx(self.root / "m.trx", migrated)), 0.5)
        self.assertEqual(["A.One.Run"], report["regressions"])

    def test_missing_class_name_is_not_a_parser_crash(self) -> None:
        path = write_trx(self.root / "missing-class.trx", {"A.One.Run": "Passed"})
        path.write_text(path.read_text().replace('className="A.One" ', ""), encoding="utf-8")
        self.assertEqual({"Run": "Passed"}, trx.results(path))

    def test_already_qualified_names_are_not_prefixed_twice(self) -> None:
        path = write_trx(self.root / "qualified.trx", {"A.One.Run": "Passed"})
        path.write_text(path.read_text().replace('testName="Run"', 'testName="A.One.Run"'), encoding="utf-8")
        self.assertEqual({"A.One.Run": "Passed"}, trx.results(path))

    def test_an_empty_baseline_cannot_prove_parity(self) -> None:
        self.assertEqual(1, self.run_compare({}, {"A.One.Run": "Passed"}))


if __name__ == "__main__":
    unittest.main()
