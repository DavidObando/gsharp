#!/usr/bin/env python3
"""Reject any ADR-0198 report that is not a genuine certification.

The controller already fails closed; this check is the second, independent
reader of its report, used by the integrated certification script so a wrong
exit code, a stale file, or a partially written report cannot pass as success.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


class ReportError(Exception):
    pass


def verify(report: Any, assemblies: list[str], tests: int) -> None:
    if not isinstance(report, dict):
        raise ReportError("report is not a JSON object")
    if report.get("schema") != 1:
        raise ReportError(f"unsupported report schema: {report.get('schema')!r}")
    if report.get("certified") is not True:
        raise ReportError(f"report is not certified: {report.get('error')!r}")
    if report.get("error"):
        raise ReportError(f"certified report carries an error: {report['error']!r}")
    rows = report.get("comparison")
    if not isinstance(rows, list):
        raise ReportError("report has no comparison rows")
    compared = {row.get("assembly"): row for row in rows if isinstance(row, dict)}
    for assembly in assemblies:
        row = compared.get(assembly)
        if row is None:
            raise ReportError(f"assembly was not compared: {assembly}")
        if row.get("normalizedEqual") is not True:
            raise ReportError(f"stage 1 and stage 2 differ: {assembly}")
    ran = report.get("tests")
    if not isinstance(ran, list) or len(ran) != tests:
        raise ReportError(f"expected {tests} test selections, found {ran!r}")
    for row in ran:
        executed = row.get("executed") if isinstance(row, dict) else None
        if (not isinstance(executed, int) or isinstance(executed, bool)
                or executed <= 0 or row.get("failed") != 0
                or row.get("outcome") != "Completed"):
            raise ReportError(f"test selection has no positive passing evidence: {row!r}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--assembly", action="append", default=[])
    parser.add_argument("--tests", type=int, default=0)
    args = parser.parse_args(argv)
    try:
        verify(json.loads(args.report.read_text(encoding="utf-8")), args.assembly, args.tests)
    except (OSError, ValueError, ReportError) as error:
        print(f"verify-stage2-report: {error}", file=sys.stderr)
        return 1
    print(f"verify-stage2-report: {args.report} is a genuine certification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
