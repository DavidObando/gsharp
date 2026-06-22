#!/usr/bin/env python3
"""Convert a VSTest .trx file into the deterministic cs2gs baseline JSON.

The output is intentionally minimal and stable:
  * tests are sorted by fully-qualified name,
  * only name + outcome are kept per test (no durations / timestamps / ids),
  * pass/fail/skip counts are derived from the outcomes,
  * no machine-specific paths appear anywhere.

This is the C# parity oracle for ADR-0115 stage 4: the G# port must reproduce
the same {name -> outcome} set.
"""
import json
import sys
import xml.etree.ElementTree as ET

TRX_NS = "{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}"


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: trx-to-baseline.py <results.trx> <appId>\n")
        return 2

    trx_path, app_id = sys.argv[1], sys.argv[2]
    tree = ET.parse(trx_path)
    root = tree.getroot()

    tests = []
    for result in root.iter(f"{TRX_NS}UnitTestResult"):
        name = result.get("testName")
        outcome = result.get("outcome")
        if name is None or outcome is None:
            continue
        tests.append({"name": name, "outcome": outcome})

    tests.sort(key=lambda t: t["name"])

    passed = sum(1 for t in tests if t["outcome"] == "Passed")
    failed = sum(1 for t in tests if t["outcome"] == "Failed")
    skipped = len(tests) - passed - failed

    baseline = {
        "schemaVersion": "1.0",
        "app": app_id,
        "framework": "xunit",
        "total": len(tests),
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "tests": tests,
    }

    json.dump(baseline, sys.stdout, indent=2, sort_keys=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
