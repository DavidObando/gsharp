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


def write_trx(path: Path, outcomes: dict[str, str] | list[tuple[str, str]],
              summary: str = "Completed") -> Path:
    results, definitions = [], []
    rows = outcomes.items() if isinstance(outcomes, dict) else outcomes
    for index, (name, outcome) in enumerate(rows):
        owner, method = name.rsplit(".", 1)
        results.append(f'<UnitTestResult testId="id{index}" testName="{method}" outcome="{outcome}" />')
        definitions.append(f'<UnitTest id="id{index}" name="{method}"><TestMethod className="{owner}" name="{method}" /></UnitTest>')
    path.write_text(
        '<?xml version="1.0" encoding="utf-8"?>'
        '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">'
        f'<Results>{"".join(results)}</Results><TestDefinitions>{"".join(definitions)}</TestDefinitions>'
        f'<ResultSummary outcome="{summary}" /></TestRun>',
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
        self.assertEqual([("Run", "Passed")], trx.results(path).rows)

    def test_already_qualified_names_are_not_prefixed_twice(self) -> None:
        path = write_trx(self.root / "qualified.trx", {"A.One.Run": "Passed"})
        path.write_text(path.read_text().replace('testName="Run"', 'testName="A.One.Run"'), encoding="utf-8")
        self.assertEqual([("A.One.Run", "Passed")], trx.results(path).rows)

    def test_an_empty_baseline_cannot_prove_parity(self) -> None:
        self.assertEqual(1, self.run_compare({}, {"A.One.Run": "Passed"}))

    def test_a_late_aborted_or_error_run_fails_above_the_ratio(self) -> None:
        baseline = {f"A.T.Pass{i}": "Passed" for i in range(100)}
        for summary in ("Aborted", "Error"):
            for invalid in ("baseline", "migrated"):
                with self.subTest(summary=summary, invalid=invalid):
                    b = write_trx(self.root / "b.trx", baseline,
                                  summary if invalid == "baseline" else "Completed")
                    m = write_trx(self.root / "m.trx", dict(list(baseline.items())[:96]),
                                  summary if invalid == "migrated" else "Completed")
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(1, trx.main(["--baseline", str(b), "--migrated", str(m)]))

    def test_duplicate_display_names_do_not_hide_a_failure(self) -> None:
        b = write_trx(self.root / "b.trx", [("A.T.Same", "Passed"), ("A.T.Same", "Passed")])
        m = write_trx(self.root / "m.trx", [("A.T.Same", "Failed"), ("A.T.Same", "Passed")])
        report = trx.compare(trx.results(b), trx.results(m), 0.95)
        self.assertFalse(report["ok"])
        self.assertEqual(2, report["baselineExecuted"])
        self.assertEqual(2, report["migratedExecuted"])
        self.assertEqual(1, report["migratedFailed"])
        self.assertEqual(["A.T.Same"], report["regressions"])

    def test_losing_duplicate_rows_fails_the_execution_ratio(self) -> None:
        b = write_trx(self.root / "b.trx", [("A.T.Same", "Passed")] * 100)
        m = write_trx(self.root / "m.trx", [("A.T.Same", "Passed")] * 94)
        report = trx.compare(trx.results(b), trx.results(m), 0.95)
        self.assertTrue(report["truncated"])
        self.assertFalse(report["ok"])

    def test_exact_execution_ratio_boundary_passes(self) -> None:
        b = write_trx(self.root / "b.trx", [("A.T.Same", "Passed")] * 100)
        m = write_trx(self.root / "m.trx", [("A.T.Same", "Passed")] * 95)
        self.assertTrue(trx.compare(trx.results(b), trx.results(m), 0.95)["ok"])

    def test_shared_failures_with_failed_run_summary_are_allowed(self) -> None:
        b = write_trx(self.root / "b.trx", [("A.T.Pass", "Passed"), ("A.T.Fail", "Failed")],
                      "Failed")
        m = write_trx(self.root / "m.trx", [("A.T.Pass", "Passed"), ("A.T.Fail", "Failed")],
                      "Failed")
        self.assertTrue(trx.compare(trx.results(b), trx.results(m), 0.95)["ok"])

    def test_missing_summary_cannot_prove_a_completed_run(self) -> None:
        b = write_trx(self.root / "b.trx", {"A.T.Pass": "Passed"})
        m = write_trx(self.root / "m.trx", {"A.T.Pass": "Passed"})
        m.write_text(m.read_text().replace('<ResultSummary outcome="Completed" />', ""), encoding="utf-8")
        report = trx.compare(trx.results(b), trx.results(m), 0.95)
        self.assertFalse(report["ok"])
        self.assertEqual({"migrated": "Unknown"}, report["invalidRuns"])

    def test_extra_duplicate_failure_is_not_shared_with_one_baseline_failure(self) -> None:
        b = write_trx(self.root / "b.trx", [("A.T.Same", "Failed"), ("A.T.Same", "Passed")],
                      "Failed")
        m = write_trx(self.root / "m.trx", [("A.T.Same", "Failed"), ("A.T.Same", "Failed")],
                      "Failed")
        report = trx.compare(trx.results(b), trx.results(m), 0.95)
        self.assertFalse(report["ok"])
        self.assertEqual(["A.T.Same"], report["regressions"])
        self.assertEqual(["A.T.Same"], report["sharedFailures"])


if __name__ == "__main__":
    unittest.main()
