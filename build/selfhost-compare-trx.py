#!/usr/bin/env python3
"""Compare a migrated test run against its C# original by failing-test set.

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
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {"t": "http://microsoft.com/schemas/VisualStudio/TeamTest/2010"}


def results(trx: Path) -> dict[str, str]:
    """Maps `Class.Method(args)` to its outcome."""
    root = ET.parse(trx).getroot()
    classes = {}
    for test in root.iterfind("t:TestDefinitions/t:UnitTest", NS):
        method = test.find("t:TestMethod", NS)
        classes[test.get("id")] = method.get("className") if method is not None else ""
    outcomes = {}
    for result in root.iterfind("t:Results/t:UnitTestResult", NS):
        name = result.get("testName", "")
        owner = classes.get(result.get("testId"), "")
        key = name if name.startswith(owner + ".") or not owner else owner + "." + name
        outcomes[key] = result.get("outcome", "Unknown")
    return outcomes


def compare(baseline: dict[str, str], migrated: dict[str, str], min_ratio: float) -> dict:
    failed = lambda run: {name for name, outcome in run.items() if outcome not in ("Passed", "NotExecuted")}
    executed = lambda run: sum(1 for outcome in run.values() if outcome != "NotExecuted")
    regressions = sorted(failed(migrated) - failed(baseline))
    report = {
        "baselineExecuted": executed(baseline), "migratedExecuted": executed(migrated),
        "baselineFailed": len(failed(baseline)), "migratedFailed": len(failed(migrated)),
        "regressions": regressions,
        "sharedFailures": sorted(failed(migrated) & failed(baseline)),
        "fixedInMigrated": sorted(failed(baseline) - failed(migrated)),
    }
    truncated = report["migratedExecuted"] < min_ratio * report["baselineExecuted"]
    report["truncated"] = truncated
    report["ok"] = not regressions and not truncated and report["migratedExecuted"] > 0
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
    print("migrated suite: " + ("OK" if report["ok"] else "REGRESSED"))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
