#!/usr/bin/env python3
"""Compare a migrated test run against its C# original by failing-test multiset.

Issue #4631 (C7). The migrated (G#-source) suite must not fail anything the
C# suite passes on the same machine. Platform failures the C# suite already
has (windows-nightly carries a known set) are reported, not counted against
the migration. A run that produced no results, or fewer executed tests than
`--min-ratio` of the baseline (a crashed or truncated test host, e.g. a
stack overflow on Windows' 1 MB main-thread stack), fails.

Exit: 0 no regression, 1 regression or truncated run, 2 unreadable input.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import NamedTuple

NS = {"t": "http://microsoft.com/schemas/VisualStudio/TeamTest/2010"}


class TestRun(NamedTuple):
    rows: list[tuple[str, str]]
    outcome: str


def results(trx: Path) -> TestRun:
    """Reads every TRX row, prefixing testName with className unless already present."""
    root = ET.parse(trx).getroot()
    classes = {}
    for test in root.iterfind("t:TestDefinitions/t:UnitTest", NS):
        method = test.find("t:TestMethod", NS)
        classes[test.get("id")] = method.get("className", "") if method is not None else ""
    outcomes = []
    for result in root.iterfind("t:Results/t:UnitTestResult", NS):
        name = result.get("testName", "")
        owner = classes.get(result.get("testId"), "")
        key = name if name.startswith(owner + ".") or not owner else owner + "." + name
        outcomes.append((key, result.get("outcome", "Unknown")))
    summary = root.find("t:ResultSummary", NS)
    return TestRun(outcomes, summary.get("outcome", "Unknown") if summary is not None else "Unknown")


def compare(baseline: TestRun, migrated: TestRun, min_ratio: float) -> dict:
    failed = lambda run: Counter(name for name, outcome in run.rows if outcome not in ("Passed", "NotExecuted"))
    executed = lambda run: sum(1 for _, outcome in run.rows if outcome != "NotExecuted")
    baseline_failed, migrated_failed = failed(baseline), failed(migrated)
    regressions = sorted((migrated_failed - baseline_failed).elements())
    report = {
        "baselineExecuted": executed(baseline), "migratedExecuted": executed(migrated),
        "baselineFailed": baseline_failed.total(), "migratedFailed": migrated_failed.total(),
        "regressions": regressions,
        "sharedFailures": sorted((migrated_failed & baseline_failed).elements()),
        "fixedInMigrated": sorted((baseline_failed - migrated_failed).elements()),
        "invalidRuns": {name: run.outcome for name, run in (("baseline", baseline), ("migrated", migrated))
                        if run.outcome not in ("Completed", "Passed", "Failed")},
    }
    truncated = report["migratedExecuted"] < min_ratio * report["baselineExecuted"]
    report["truncated"] = truncated
    report["ok"] = (not regressions and not truncated and not report["invalidRuns"]
                    and report["baselineExecuted"] > 0 and report["migratedExecuted"] > 0)
    return report


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--baseline", required=True, type=Path, help="TRX of the C# suite")
    parser.add_argument("--migrated", required=True, type=Path, help="TRX of the migrated suite")
    parser.add_argument("--min-ratio", type=float, default=0.95,
                        help="minimum migrated/baseline executed-test ratio (default 0.95)")
    parser.add_argument("--out", type=Path, help="write the JSON report here")
    args = parser.parse_args(argv)
    try:
        baseline, migrated = results(args.baseline), results(args.migrated)
    except (OSError, ET.ParseError) as error:
        print(f"selfhost-compare-trx: {error}", file=sys.stderr)
        return 2
    report = compare(baseline, migrated, args.min_ratio)
    if args.out:
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"baseline executed {report['baselineExecuted']}, failed {report['baselineFailed']}; "
          f"migrated executed {report['migratedExecuted']}, failed {report['migratedFailed']}")
    for name in report["regressions"][:50]:
        print(f"  REGRESSION {name}")
    if report["truncated"]:
        print("  TRUNCATED: the migrated run executed too few tests (crashed test host?)")
    if report["baselineExecuted"] == 0:
        print("  NO BASELINE: the C# run executed no tests")
    for name, outcome in report["invalidRuns"].items():
        print(f"  INVALID RUN: {name} summary outcome {outcome}")
    print("migrated suite: " + ("OK" if report["ok"] else "REGRESSED"))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
