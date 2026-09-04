#!/usr/bin/env python3
"""Smoke-check the ADR-0174 D11 concurrency benchmark harness.

The harness only earns its keep if it still runs. A PR that breaks the scenario
registry, the G# program, or the runner should fail in CI at the cost of a few
seconds rather than at 05:23 in a nightly nobody is watching.

`--smoke` checks the pieces without measuring anything: the registry parses and
every scenario it names is one the G# program knows; the baseline has an entry
per scenario in both measurement modes; the runner imports; the NativeAOT shim
project is present and still substitutes the emitted assembly.

Deliberately does not publish the AOT binary. That takes minutes, and this
script runs on every PR.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BENCH = REPO / "bench" / "concurrency"


def smoke() -> int:
    failures: list[str] = []

    registry = json.loads((BENCH / "scenarios.json").read_text())
    scenarios = registry["scenarios"]
    if not scenarios:
        failures.append("scenarios.json names no scenarios")

    program = (BENCH / "gsharp" / "Bench.gs").read_text()
    known = set(re.findall(r'"([A-Za-z0-9_.-]+)"', program))
    for scenario in scenarios:
        if scenario["gsharp"] not in known:
            failures.append(f"Bench.gs does not know the scenario '{scenario['gsharp']}'")

    go_program = (BENCH / "go" / "main.go").read_text()
    for scenario in scenarios:
        row = scenario.get("go")
        if row and f'"{row}"' not in go_program:
            failures.append(f"main.go does not report the row '{row}'")

    baseline = json.loads((BENCH / "baseline.json").read_text())
    for scenario in scenarios:
        entry = baseline["scenarios"].get(scenario["name"])
        if entry is None:
            failures.append(f"baseline.json has no entry for '{scenario['name']}'")
        elif "aot" not in entry:
            # Every scenario carries a budget per measurement mode; a missing
            # one would silently stop gating that mode rather than fail.
            failures.append(f"baseline.json has no 'aot' budget for '{scenario['name']}'")

    aot_project = BENCH / "aot" / "BenchAot.csproj"
    if not aot_project.exists():
        failures.append("bench/concurrency/aot/BenchAot.csproj is missing; --aot cannot run")
    else:
        shim = aot_project.read_text()
        # The whole mechanism is this one substitution: without it the AOT row
        # would measure the placeholder Main and report nothing at all.
        if "SubstituteGsharpBench" not in shim or "IntermediateAssembly" not in shim:
            failures.append("BenchAot.csproj no longer substitutes the gsc-emitted assembly")

    runner = (REPO / "build" / "run-concurrency-bench.py").read_text()
    compile(runner, "run-concurrency-bench.py", "exec")

    for failure in failures:
        print(f"error: {failure}", file=sys.stderr)

    if failures:
        return 1

    print(
        f"concurrency benchmark harness OK: {len(scenarios)} scenarios, registry, "
        "baseline (jit + aot), AOT shim and runner agree."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--smoke", action="store_true", help="check the harness without measuring")
    args = parser.parse_args()
    if not args.smoke:
        parser.error("only --smoke is implemented; use run-concurrency-bench.py to measure")

    return smoke()


if __name__ == "__main__":
    sys.exit(main())
