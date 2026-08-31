#!/usr/bin/env python3
"""Prove that build.yml's ``tests`` matrix runs every test exactly once.

The shards are ``--filter`` expressions over substrings of the fully-qualified
test name. Substring matching does not compose the way the band names suggest —
``Emit.Issue1`` also selects ``Emit.Issue10`` — so "which shard runs this test"
is only answerable against the real enumerated test list. A rebalance that
looks obviously right can drop a band's worth of coverage and leave every shard
green, which is strictly worse than a slow pipeline.

So: enumerate every test in every test assembly, evaluate every shard's filter
over that list, and assert the shards partition it. Both directions matter —
an uncovered test is lost coverage, a test in two shards is wasted time and a
flake that reproduces "only sometimes".

Enumeration uses ``dotnet vstest --ListFullyQualifiedTests``; ``dotnet test
--list-tests`` prints display names, which are not what the filters match.

The environment matters: a data-driven theory can enumerate differently under
different environment variables (``GSHARP_DIFFERENTIAL_CONFORMANCE`` widens the
language-conformance corpus from a curated subset to the whole thing). Run this
with the same environment the shards use, which is to say: do not set it.

Usage: verify-ci-test-partition.py [--solution GSharp.sln] [--configuration Release]
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def matrix(solution: str) -> list[dict]:
    generator = Path(__file__).resolve().parent / "generate-ci-test-matrix.py"
    result = subprocess.run(
        [sys.executable, str(generator), solution],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)["include"]


def assembly_for(project: str, configuration: str, repo_root: Path) -> Path:
    """Finds the test assembly a project builds.

    The output assembly name does not always match the project file name
    (``Core.Tests.csproj`` builds ``GSharp.Core.Tests.dll``), so glob the
    project's output directory rather than guessing.
    """
    output = repo_root / "out" / "bin" / configuration / Path(project).stem
    candidates = sorted(output.glob("*.Tests.dll"))
    if not candidates:
        raise SystemExit(f"verify-ci-test-partition: no test assembly under {output}.")
    return candidates[0]


def list_tests(assembly: Path) -> list[str]:
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as handle:
        listing = Path(handle.name)
    try:
        subprocess.run(
            ["dotnet", "vstest", str(assembly),
             "--ListFullyQualifiedTests", f"--ListTestsTargetPath:{listing}"],
            check=True, capture_output=True, text=True,
        )
        return [line.strip() for line in listing.read_text(encoding="utf-8").splitlines() if line.strip()]
    finally:
        listing.unlink(missing_ok=True)


def matches(test: str, expression: str) -> bool:
    """Evaluates the ``FullyQualifiedName`` subset of the vstest filter grammar.

    The generator only ever emits ``a|b|c``, ``a&!x&!y`` or ``(a|b)&!x``, so
    this handles exactly that: an optional parenthesised OR of ``~`` terms
    followed by ``&``-joined ``!~`` terms. Anything else is rejected rather
    than approximated — a verifier that quietly mis-parses the thing it is
    verifying is worse than no verifier.
    """
    if not expression:
        return True

    lowered = test.lower()
    includes: list[str] = []
    excludes: list[str] = []
    for clause in split_top_level(expression):
        if clause.startswith("(") and clause.endswith(")"):
            for term in clause[1:-1].split("|"):
                includes.append(require(term, "FullyQualifiedName~"))
        elif "|" in clause:
            for term in clause.split("|"):
                includes.append(require(term, "FullyQualifiedName~"))
        elif clause.startswith("FullyQualifiedName!~"):
            excludes.append(require(clause, "FullyQualifiedName!~"))
        else:
            includes.append(require(clause, "FullyQualifiedName~"))

    if includes and not any(term.lower() in lowered for term in includes):
        return False
    return not any(term.lower() in lowered for term in excludes)


def split_top_level(expression: str) -> list[str]:
    """Splits on ``&`` outside parentheses."""
    clauses: list[str] = []
    depth = 0
    current = ""
    for char in expression:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "&" and depth == 0:
            clauses.append(current)
            current = ""
        else:
            current += char
    clauses.append(current)
    return clauses


def require(clause: str, prefix: str) -> str:
    clause = clause.strip()
    if not clause.startswith(prefix):
        raise SystemExit(f"verify-ci-test-partition: unsupported filter clause '{clause}'.")
    return clause[len(prefix):]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--solution", default="GSharp.sln")
    parser.add_argument("--configuration", default="Release")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    entries = matrix(args.solution)

    # One enumeration per project, however many shards share it.
    shards_by_project: dict[str, list[dict]] = {}
    for entry in entries:
        for project in entry["project"].split():
            shards_by_project.setdefault(project, []).append(entry)

    failures: list[str] = []
    total = 0
    for project, shards in sorted(shards_by_project.items()):
        tests = list_tests(assembly_for(project, args.configuration, repo_root))
        total += len(tests)
        owners = {test: [s["name"] for s in shards if matches(test, s["filter"])] for test in tests}

        missing = sorted(test for test, names in owners.items() if not names)
        duplicated = sorted(test for test, names in owners.items() if len(names) > 1)
        counts = {
            shard["name"]: sum(1 for names in owners.values() if shard["name"] in names)
            for shard in shards
        }
        print(f"{project}: {len(tests)} tests")
        for name, count in sorted(counts.items()):
            print(f"    {count:6d}  {name}")

        if missing:
            failures.append(
                f"{project}: {len(missing)} test(s) match no shard, e.g. " + ", ".join(missing[:5]))
        if duplicated:
            failures.append(
                f"{project}: {len(duplicated)} test(s) match several shards, e.g. "
                + ", ".join(f"{t} ({', '.join(owners[t])})" for t in duplicated[:5]))
        empty = sorted(name for name, count in counts.items() if count == 0)
        if empty:
            failures.append(f"{project}: shard(s) select nothing at all: {', '.join(empty)}")

    if failures:
        print()
        for failure in failures:
            print("FAIL: " + failure, file=sys.stderr)
        return 1

    print(f"\nOK: {total} tests, each run by exactly one of {len(entries)} shards.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
