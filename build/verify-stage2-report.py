#!/usr/bin/env python3
"""Reject any ADR-0198 report that is not a genuine certification.

The controller already fails closed; this check is the second, independent
reader of its report, used by the integrated certification script so a wrong
exit code, a stale file, or a partially written report cannot pass as success.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import selfhost_pe  # noqa: E402  (the controller's own PE fingerprinting)


class ReportError(Exception):
    pass


HEX64 = re.compile(r"[0-9a-f]{64}")


def digest(value: Any) -> bool:
    return isinstance(value, str) and HEX64.fullmatch(value) is not None


def file_sha256(path: Any) -> str:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except (OSError, TypeError, ValueError) as error:
        raise ReportError(f"evidence file cannot be read: {path!r}") from error


def verify_evidence(report: dict[str, Any], row: dict[str, Any], key: str) -> None:
    """Re-read the controller-owned evidence a test row names and rehash it."""
    try:
        receipt = json.loads(Path(row["receipt"]).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ReportError(f"test receipt cannot be read: {key[:120]}") from error
    if (not isinstance(receipt, dict) or not isinstance(report.get("runId"), str)
            or receipt.get("runId") != report["runId"] or receipt.get("exitCode") != 0
            or receipt.get("purpose") != "test"):
        raise ReportError(f"test receipt does not belong to this passing run: {key[:120]}")
    events = receipt.get("events")
    if (not isinstance(events, dict)
            or file_sha256(events.get("path")) != row["eventSha256"]):
        raise ReportError(f"test event log does not match its recorded hash: {key[:120]}")
    if events.get("sha256") != row["eventSha256"]:
        raise ReportError(f"receipt event hash differs from the report: {key[:120]}")
    # The reported counts must come from the event log itself, with the same
    # complete-positive-run invariants the controller enforces. (The envelope
    # MAC is keyed by a controller-private secret, so only the controller can
    # check it; sequence continuity and the shape are checked here.)
    payloads: list[dict[str, Any]] = []
    try:
        for expected, line in enumerate(
                Path(events["path"]).read_text(encoding="utf-8").splitlines()):
            envelope = json.loads(line)
            if envelope["sequence"] != expected or not isinstance(envelope["mac"], str):
                raise ValueError("sequence")
            payloads.append(json.loads(envelope["payload"]))
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ReportError(f"test event log is not parseable: {key[:120]}") from error
    starts = [p for p in payloads if p.get("type") == "started"]
    completed = [p for p in payloads if p.get("type") == "completed"]
    results = [p for p in payloads if p.get("type") == "result"]
    if len(starts) != 1 or len(completed) != 1 or completed[0].get("failed", 0) != 0 \
            or completed[0].get("canceled") or completed[0].get("aborted") \
            or any(r.get("outcome") != "Passed" for r in results):
        raise ReportError(f"test event log is not one complete passing run: {key[:120]}")
    if not (len(results) == completed[0].get("total") == row["executed"]):
        raise ReportError(
            f"reported test count does not match the event log: {key[:120]} "
            f"(report {row['executed']}, results {len(results)}, "
            f"completed {completed[0].get('total')})")
    # The receipt's own command must be the selected test target and filter.
    arguments = receipt.get("arguments")
    if (not isinstance(arguments, list) or len(arguments) < 3
            or Path(str(arguments[2])).name != Path(row["testAssembly"]["path"]).name):
        raise ReportError(f"receipt command does not run the reported test assembly: {key[:120]}")
    filters = [a.split(":", 1)[1] for a in arguments
               if isinstance(a, str) and a.startswith("--TestCaseFilter:")]
    if filters != ([row["filter"]] if row.get("filter") else []):
        raise ReportError(f"receipt command does not carry the reported filter: {key[:120]}")
    if file_sha256(row["testAssembly"].get("path")) != row["testAssembly"]["sha256"]:
        raise ReportError(f"test assembly does not match its recorded hash: {key[:120]}")
    adapter = next((argument.split(":", 1)[1] for argument in receipt.get("arguments", [])
                    if isinstance(argument, str) and argument.startswith("--TestAdapterPath:")), None)
    if adapter is None or file_sha256(Path(adapter) / "Adr0198.TestLogger.dll") != row["loggerSha256"]:
        raise ReportError(f"test logger does not match its recorded hash: {key[:120]}")


def verify(report: Any, assemblies: list[str], tests: list[str],
           floors: dict[str, int] | None = None) -> None:
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
                or not all(digest(stage.get(field))
                           for stage in (stage1, stage2)
                           for field in ("normalized_sha256", "raw_sha256"))
                or stage1["normalized_sha256"] != stage2["normalized_sha256"]
                or not isinstance(row.get("rawEqual"), bool)
                or row["rawEqual"] != (stage1["raw_sha256"] == stage2["raw_sha256"])):
            raise ReportError(f"comparison lacks consistent stage fingerprints: {assembly}")
        # Never trust the reported hashes: re-read both PEs the report names.
        try:
            left, right, equal = selfhost_pe.compare(
                Path(stage1["path"]), Path(stage2["path"]))
        except (OSError, KeyError, TypeError, selfhost_pe.PeError) as error:
            raise ReportError(f"compared PE cannot be re-read: {assembly}: {error}") from error
        if (not equal or left.normalized_sha256 != stage1["normalized_sha256"]
                or right.normalized_sha256 != stage2["normalized_sha256"]
                or left.raw_sha256 != stage1["raw_sha256"]
                or right.raw_sha256 != stage2["raw_sha256"]):
            raise ReportError(f"re-read PE fingerprints differ from the report: {assembly}")
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
        floor = (floors or {}).get(str(row.get("project")))
        if floor is not None and executed < floor:
            raise ReportError(
                f"{row.get('project')} executed {executed} tests, below the expected floor {floor}")
        verify_evidence(report, row, key)
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
    parser.add_argument(
        "--min-executed", action="append", default=[], metavar="PROJECT=N",
        help="minimum executed tests for a project (guards against a vacuous selection)")
    args = parser.parse_args(argv)
    floors: dict[str, int] = {}
    for item in args.min_executed:
        project, _, count = item.rpartition("=")
        if not project or not count.isdigit():
            parser.error(f"--min-executed must be PROJECT=N: {item!r}")
        floors[project] = int(count)
    try:
        verify(json.loads(args.report.read_text(encoding="utf-8")),
               args.assembly, args.test, floors)
    except (OSError, ValueError, ReportError) as error:
        print(f"verify-stage2-report: {error}", file=sys.stderr)
        return 1
    print(f"verify-stage2-report: {args.report} is a genuine certification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
