#!/usr/bin/env python3
"""Run the ADR-0174 D11 concurrency benchmark and compare against the baseline.

The harness exists to make the ADR's performance claims refutable. Two things
follow from that, and both are enforced here rather than left to discipline:

  * A number that was not measured is never written. `--update-baseline`
    refuses to loosen a ceiling unless `--allow-regression` names a reason, the
    same ratchet the self-migration corpus uses.
  * The two gates are separate. The within-runtime check (G# against its own
    last recorded median) is stable enough to fail a build. The G#-vs-Go ratio
    moves with the Go toolchain and the machine, so it is reported and never
    gates.

Methodology, normative per D11: Release builds on both sides, three in-process
warm-up rounds inside each program, and several process launches here, because
in-process repetition alone understates variance.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import random
import re
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BENCH = REPO / "bench" / "concurrency"
ROW = re.compile(r"^(?P<name>[A-Za-z0-9_.-]+) ns_per_op (?P<value>[0-9]+(?:\.[0-9]+)?)$")
GO_ROW = re.compile(r"^\[(?P<name>[^\]]+?)\s*\]\s+[0-9.]+ ms\s+(?P<value>[0-9.]+) ns/op$")


def load_scenarios() -> list[dict]:
    return json.loads((BENCH / "scenarios.json").read_text())["scenarios"]


def hardware_class() -> str:
    return f"{platform.system().lower()}-{platform.machine().lower()}-{os.cpu_count()}"


def run_gsharp(launches: int, scenario: str | None, gsc: Path, extensions: Path, out: Path) -> dict[str, list[float]]:
    program = BENCH / "gsharp" / "Bench.gs"
    assembly = out / "Bench.dll"
    subprocess.run(
        [str(gsc), str(program), f"/out:{assembly}", f"/r:{extensions}"],
        check=True,
        cwd=out,
        stdout=subprocess.DEVNULL,
    )

    # gsc copies the channel runtime beside an emitted program, but not
    # Gsharp.Extensions: the `chunks` scenarios call into it, so without this
    # the program starts, prints its header, and dies on the first chunked
    # round with a FileNotFoundException.
    shutil.copy2(extensions, out / extensions.name)

    samples: dict[str, list[float]] = {}
    env = dict(os.environ)
    if scenario:
        env["GSHARP_BENCH_SCENARIO"] = scenario

    for _ in range(launches):
        result = subprocess.run(
            ["dotnet", "exec", str(assembly)],
            capture_output=True,
            text=True,
            cwd=out,
            env=env,
        )
        if result.returncode != 0:
            # A benchmark that cannot run is a failure worth reading, not a
            # stack trace from subprocess about an exit code.
            raise SystemExit(
                f"benchmark run failed (exit {result.returncode}):\n"
                f"{result.stdout}\n{result.stderr}"
            )

        for line in result.stdout.splitlines():
            match = ROW.match(line.strip())
            if match:
                samples.setdefault(match["name"], []).append(float(match["value"]))

    return samples


def run_go(launches: int) -> dict[str, list[float]]:
    if shutil.which("go") is None:
        return {}

    go_dir = BENCH / "go"
    binary = go_dir / "baseline"
    subprocess.run(["go", "build", "-o", "baseline", "."], check=True, cwd=go_dir, stdout=subprocess.DEVNULL)

    samples: dict[str, list[float]] = {}
    for _ in range(launches):
        result = subprocess.run([str(binary)], check=True, capture_output=True, text=True, cwd=go_dir)
        for line in result.stdout.splitlines():
            match = GO_ROW.match(line.strip())
            if match:
                samples.setdefault(match["name"], []).append(float(match["value"]))

    return samples


def bootstrap_ci95(values: list[float], iterations: int = 2000) -> list[float] | None:
    """A percentile bootstrap of the median. Reporting a single number from a
    handful of launches overstates what was measured."""
    if len(values) < 3:
        return None

    rng = random.Random(1337)
    medians = sorted(
        statistics.median(rng.choices(values, k=len(values))) for _ in range(iterations)
    )
    lo = medians[int(0.025 * iterations)]
    hi = medians[int(0.975 * iterations)]
    return [round(lo, 2), round(hi, 2)]


def summarize(samples: dict[str, list[float]]) -> dict[str, dict]:
    return {
        name: {
            "median_ns": round(statistics.median(values), 2),
            "ci95_ns": bootstrap_ci95(values),
            "samples": len(values),
        }
        for name, values in samples.items()
    }


def check(baseline: dict, measured: dict[str, dict], scenarios: list[dict]) -> int:
    """The within-runtime gate. A scenario fails only when its median is above
    the recorded ceiling AND the confidence intervals do not overlap AND the
    hardware class matches — three conditions, because any one of them alone
    produces false failures often enough to get the gate switched off."""
    failures = 0
    recorded_class = baseline.get("hardwareClass")
    current_class = hardware_class()
    if recorded_class is not None and recorded_class != current_class:
        print(f"note: baseline was recorded on '{recorded_class}', this is '{current_class}'; reporting only.")

    for scenario in scenarios:
        name = scenario["name"]
        entry = baseline["scenarios"].get(name, {})
        ceiling = entry.get("ceiling_ns")
        result = measured.get(name)
        if result is None:
            print(f"  {name:<14} not measured")
            continue

        if ceiling is None:
            print(f"  {name:<14} {result['median_ns']:>9.2f} ns/op   (no ceiling recorded yet)")
            continue

        over = result["median_ns"] > ceiling
        recorded_ci = entry.get("ci95_ns")
        disjoint = (
            recorded_ci is not None
            and result["ci95_ns"] is not None
            and result["ci95_ns"][0] > recorded_ci[1]
        )
        gated = recorded_class is None or recorded_class == current_class
        verdict = "REGRESSED" if (over and disjoint and gated) else "ok"
        if verdict == "REGRESSED":
            failures += 1

        print(f"  {name:<14} {result['median_ns']:>9.2f} ns/op   ceiling {ceiling:>9.2f}   {verdict}")

    return failures


def update(baseline: dict, measured: dict[str, dict], go_measured: dict[str, dict], scenarios: list[dict], allow_regression: str | None) -> int:
    for scenario in scenarios:
        name = scenario["name"]
        result = measured.get(name)
        if result is None:
            continue

        entry = baseline["scenarios"].setdefault(name, {"history": []})
        ceiling = round(result["median_ns"] * 1.15, 2)
        previous = entry.get("ceiling_ns")
        if previous is not None and ceiling > previous and not allow_regression:
            print(
                f"refusing to loosen '{name}' from {previous} to {ceiling} ns/op. "
                "Pass --allow-regression \"<reason>\" if this is a deliberate, explained change.",
                file=sys.stderr,
            )
            return 1

        entry["median_ns"] = result["median_ns"]
        entry["ci95_ns"] = result["ci95_ns"]
        entry["ceiling_ns"] = ceiling
        go_row = scenario.get("go")
        if go_row and go_row in go_measured:
            entry["go_median_ns"] = go_measured[go_row]["median_ns"]
        entry.setdefault("target_vs_go", None)
        entry.setdefault("target_status", "provisional")
        entry.setdefault("history", []).append(
            {
                "median_ns": result["median_ns"],
                "samples": result["samples"],
                "hardwareClass": hardware_class(),
                "reason": allow_regression,
            }
        )

    baseline["hardwareClass"] = hardware_class()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--launches", type=int, default=7, help="process launches per side (default 7)")
    parser.add_argument("--scenario", help="run one scenario instead of all of them")
    parser.add_argument("--go", action="store_true", help="also run the Go side and report the ratio")
    parser.add_argument("--check-baseline", metavar="PATH", help="fail when a scenario regressed past its ceiling")
    parser.add_argument("--update-baseline", metavar="PATH", help="record the measured medians")
    parser.add_argument("--allow-regression", metavar="REASON", help="permit --update-baseline to loosen a ceiling")
    parser.add_argument("--gsc", default=str(REPO / "out" / "bin" / "Release" / "Compiler" / "gsc"), help="path to gsc")
    parser.add_argument("--extensions", default=str(REPO / "out" / "bin" / "Release" / "Gsharp.Extensions" / "Gsharp.Extensions.dll"))
    parser.add_argument("--json", metavar="PATH", help="write the measured results as JSON")
    args = parser.parse_args()

    scenarios = load_scenarios()
    if args.scenario:
        scenarios = [s for s in scenarios if s["name"] == args.scenario]
        if not scenarios:
            print(f"unknown scenario '{args.scenario}'", file=sys.stderr)
            return 2

    out = REPO / "out" / "bench-concurrency"
    out.mkdir(parents=True, exist_ok=True)

    measured = summarize(run_gsharp(args.launches, args.scenario, Path(args.gsc), Path(args.extensions), out))
    go_measured = summarize(run_go(args.launches)) if args.go else {}

    print(f"hardware class: {hardware_class()}   launches: {args.launches}")
    for scenario in scenarios:
        name = scenario["name"]
        result = measured.get(name)
        if result is None:
            continue

        line = f"  {name:<14} {result['median_ns']:>9.2f} ns/op"
        go_row = scenario.get("go")
        if go_row and go_row in go_measured:
            go_median = go_measured[go_row]["median_ns"]
            line += f"   go {go_median:>9.2f} ns/op   ratio {result['median_ns'] / go_median:>5.2f}x"

        print(line)

    if args.json:
        Path(args.json).write_text(json.dumps({"gsharp": measured, "go": go_measured, "hardwareClass": hardware_class()}, indent=2) + "\n")

    if args.update_baseline:
        path = Path(args.update_baseline)
        baseline = json.loads(path.read_text())
        code = update(baseline, measured, go_measured, scenarios, args.allow_regression)
        if code:
            return code

        path.write_text(json.dumps(baseline, indent=2) + "\n")
        print(f"updated {path}")

    if args.check_baseline:
        baseline = json.loads(Path(args.check_baseline).read_text())
        print("\nwithin-runtime gate:")
        failures = check(baseline, measured, scenarios)
        if failures:
            print(f"\n{failures} scenario(s) regressed past their recorded ceiling.", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
