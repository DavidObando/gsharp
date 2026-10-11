#!/usr/bin/env python3
"""Reject any ADR-0198 report that is not a genuine certification.

The controller already fails closed; this check is the second, independent
reader of its report, used by the integrated certification script so a wrong
exit code, a stale file, or a partially written report cannot pass as success.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


class ReportError(Exception):
    pass


HEX64 = re.compile(r"[0-9a-f]{64}")


def digest(value: Any) -> bool:
    return isinstance(value, str) and HEX64.fullmatch(value) is not None


def verify(report: Any, assemblies: list[str], tests: list[str]) -> None:
    if not assemblies or not tests:
        raise ReportError("expected assemblies and test selections must not be empty")
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
    compared: dict[Any, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("assembly"), str):
            raise ReportError(f"malformed comparison row: {row!r}")
        if row["assembly"] in compared:
            raise ReportError(f"duplicate comparison row: {row['assembly']}")
        compared[row["assembly"]] = row
    if set(compared) != set(assemblies):
        raise ReportError(
            f"compared assemblies differ from the expected set: "
            f"{sorted(set(compared) ^ set(assemblies))!r:.200}")
    for assembly in assemblies:
        row = compared.get(assembly)
        if row is None:
            raise ReportError(f"assembly was not compared: {assembly}")
        if row.get("normalizedEqual") is not True:
            raise ReportError(f"stage 1 and stage 2 differ: {assembly}")
        stage1, stage2 = row.get("stage1"), row.get("stage2")
        if (not isinstance(stage1, dict) or not isinstance(stage2, dict)
                or not digest(stage1.get("normalized_sha256"))
                or stage1.get("normalized_sha256") != stage2.get("normalized_sha256")
                or not isinstance(row.get("rawEqual"), bool)):
            raise ReportError(f"comparison lacks consistent stage fingerprints: {assembly}")
    ran = report.get("tests")
    if not isinstance(ran, list):
        raise ReportError("report has no test rows")
    seen: set[str] = set()
    for row in ran:
        if not isinstance(row, dict):
            raise ReportError(f"malformed test row: {row!r}")
        key = f"{row.get('project')}::{row.get('filter')}"
        if key in seen:
            raise ReportError(f"duplicate test selection: {key[:120]}")
        seen.add(key)
        executed = row.get("executed")
        if (not isinstance(executed, int) or isinstance(executed, bool)
                or executed <= 0 or row.get("failed") != 0
                or row.get("outcome") != "Completed"):
            raise ReportError(f"test selection has no positive passing evidence: {row!r}")
        assembly = row.get("testAssembly")
        hashes = row.get("assemblySha256")
        if (not isinstance(row.get("receipt"), str) or not row["receipt"]
                or not digest(row.get("eventSha256")) or not digest(row.get("loggerSha256"))
                or not isinstance(assembly, dict) or not digest(assembly.get("sha256"))
                or not isinstance(hashes, dict) or not hashes
                or not all(digest(value) for value in hashes.values())):
            raise ReportError(f"test selection lacks authenticated evidence fields: {key[:120]}")
        # The tests must have run against exactly the binaries that were compared.
        if hashes != {name: compared[name]["stage2"].get("raw_sha256") for name in assemblies}:
            raise ReportError(
                f"test evidence is not bound to the certified stage-2 binaries: {key[:120]}")
    if seen != set(tests):
        raise ReportError(
            f"test selections differ from the expected set: "
            f"missing={sorted(set(tests) - seen)!r:.200}, unexpected={sorted(seen - set(tests))!r:.200}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--assembly", action="append", default=[])
    parser.add_argument("--test", action="append", default=[], metavar="PROJECT::FILTER")
    args = parser.parse_args(argv)
    try:
        verify(json.loads(args.report.read_text(encoding="utf-8")), args.assembly, args.test)
    except (OSError, ValueError, ReportError) as error:
        print(f"verify-stage2-report: {error}", file=sys.stderr)
        return 1
    print(f"verify-stage2-report: {args.report} is a genuine certification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
