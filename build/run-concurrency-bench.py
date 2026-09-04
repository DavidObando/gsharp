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

The G# side is measured in two modes, because "how fast is G#" has two honest
answers and reporting one of them alone was how this harness first went wrong
(issues #3901, #3902):

  jit  CoreCLR with the JIT tiering delay pinned to zero. Without the pin, a
       bench process is too short-lived for call counting to ever start: the
       scenario's own loop is promoted by on-stack replacement while every
       method it calls stays at Tier0, and whether that happens at all varies
       between launches. That produced a 3.4x swing on select-ready from an
       unchanged binary. Pinning keeps dynamic PGO, so this remains the
       configuration G# actually ships into, measured at steady state.
  aot  NativeAOT. Fully compiled before the process starts, so there is no tier
       to win or lose, and it is the mode that compares like-for-like with Go's
       ahead-of-time binary.

Neither mode is "the" number. The JIT row is what a deployed G# program does;
the AOT row is what the language is capable of once compilation is not in the
way. Both are reported, and a budget may be recorded against either.
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

# Pinning the tiering delay is normative, not a tuning knob; see the module
# docstring. Without it the reported number depends on whether a 100 ms timer
# happened to elapse before the process exited.
PINNED_TIER_ENV = {"DOTNET_TC_CallCountingDelayMs": "0"}


def load_scenarios() -> list[dict]:
    return json.loads((BENCH / "scenarios.json").read_text())["scenarios"]


def hardware_class() -> str:
    return f"{platform.system().lower()}-{platform.machine().lower()}-{os.cpu_count()}"


def compile_bench(gsc: Path, extensions: Path, out: Path) -> Path:
    """Emit the G# benchmark once. Both measurement modes consume this same
    assembly, so a difference between the rows is compilation, never source."""
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
    return assembly


def publish_aot(assembly: Path, out: Path) -> Path:
    """Native-compile the emitted assembly through the SDK's AOT pipeline.

    The shim project exists so the SDK owns the `ilc` response file and the link
    step; see bench/concurrency/aot/BenchAot.csproj for why that indirection is
    worth having.
    """
    publish = out / "aot"
    result = subprocess.run(
        [
            "dotnet", "publish", str(BENCH / "aot" / "BenchAot.csproj"),
            "-c", "Release",
            "-r", aot_rid(),
            "-o", str(publish),
            f"-p:BenchAssembly={assembly}",
            f"-p:GsharpRuntimeDir={assembly.parent}",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(
            "NativeAOT publish failed. On Linux this usually means clang or "
            "zlib development headers are missing.\n"
            f"{result.stdout}\n{result.stderr}"
        )

    binary = publish / "Bench"
    if not binary.exists():
        raise SystemExit(f"NativeAOT publish produced no binary at {binary}")

    return binary


def aot_rid() -> str:
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    return f"{platform.system().lower()}-{arch}"


def measure(command: list[str], launches: int, scenario: str | None, cwd: Path, extra_env: dict[str, str]) -> dict[str, list[float]]:
    samples: dict[str, list[float]] = {}
    env = dict(os.environ)
    env.update(extra_env)
    if scenario:
        env["GSHARP_BENCH_SCENARIO"] = scenario

    for _ in range(launches):
        result = subprocess.run(command, capture_output=True, text=True, cwd=cwd, env=env)
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


def check_one(entry: dict, result: dict | None, label: str, gated: bool) -> bool:
    """Check one scenario in one mode. Returns True when it regressed."""
    if result is None:
        print(f"  {label:<20} not measured")
        return False

    ceiling = entry.get("ceiling_ns")
    if ceiling is None:
        print(f"  {label:<20} {result['median_ns']:>9.2f} ns/op   (no ceiling recorded yet)")
        return False

    over = result["median_ns"] > ceiling
    recorded_ci = entry.get("ci95_ns")
    disjoint = (
        recorded_ci is not None
        and result["ci95_ns"] is not None
        and result["ci95_ns"][0] > recorded_ci[1]
    )
    verdict = "REGRESSED" if (over and disjoint and gated) else "ok"
    print(f"  {label:<20} {result['median_ns']:>9.2f} ns/op   ceiling {ceiling:>9.2f}   {verdict}")
    return verdict == "REGRESSED"


def check(baseline: dict, measured: dict[str, dict], measured_aot: dict[str, dict], scenarios: list[dict]) -> int:
    """The within-runtime gate. A scenario fails only when its median is above
    the recorded ceiling AND the confidence intervals do not overlap AND the
    hardware class matches — three conditions, because any one of them alone
    produces false failures often enough to get the gate switched off.

    Each mode carries its own ceiling. A JIT regression and an AOT regression
    mean different things — the first is a deployment regression, the second a
    codegen or runtime one — so neither is allowed to mask the other."""
    failures = 0
    recorded_class = baseline.get("hardwareClass")
    current_class = hardware_class()
    if recorded_class is not None and recorded_class != current_class:
        print(f"note: baseline was recorded on '{recorded_class}', this is '{current_class}'; reporting only.")

    gated = recorded_class is None or recorded_class == current_class
    for scenario in scenarios:
        name = scenario["name"]
        entry = baseline["scenarios"].get(name, {})
        if check_one(entry, measured.get(name), f"{name} (jit)", gated):
            failures += 1

        if measured_aot:
            if check_one(entry.get("aot", {}), measured_aot.get(name), f"{name} (aot)", gated):
                failures += 1

    return failures


def record(entry: dict, result: dict, label: str, allow_regression: str | None) -> str | None:
    """Write one mode's measurement into its baseline entry, refusing to loosen
    a ceiling without a stated reason. Returns an error message, or None."""
    ceiling = round(result["median_ns"] * 1.15, 2)
    previous = entry.get("ceiling_ns")
    if previous is not None and ceiling > previous and not allow_regression:
        return (
            f"refusing to loosen '{label}' from {previous} to {ceiling} ns/op. "
            'Pass --allow-regression "<reason>" if this is a deliberate, explained change.'
        )

    entry["median_ns"] = result["median_ns"]
    entry["ci95_ns"] = result["ci95_ns"]
    entry["ceiling_ns"] = ceiling
    entry.setdefault("history", []).append(
        {
            "median_ns": result["median_ns"],
            "samples": result["samples"],
            "hardwareClass": hardware_class(),
            "reason": allow_regression,
        }
    )
    return None


def update(
    baseline: dict,
    measured: dict[str, dict],
    measured_aot: dict[str, dict],
    go_measured: dict[str, dict],
    scenarios: list[dict],
    allow_regression: str | None,
) -> int:
    for scenario in scenarios:
        name = scenario["name"]
        entry = baseline["scenarios"].setdefault(name, {"history": []})

        result = measured.get(name)
        if result is not None:
            error = record(entry, result, f"{name} (jit)", allow_regression)
            if error:
                print(error, file=sys.stderr)
                return 1

        aot_result = measured_aot.get(name)
        if aot_result is not None:
            aot_entry = entry.setdefault("aot", {"history": []})
            error = record(aot_entry, aot_result, f"{name} (aot)", allow_regression)
            if error:
                print(error, file=sys.stderr)
                return 1

        if result is None and aot_result is None:
            continue

        go_row = scenario.get("go")
        if go_row and go_row in go_measured:
            entry["go_median_ns"] = go_measured[go_row]["median_ns"]

        entry.setdefault("target_vs_go", None)
        entry.setdefault("target_status", "provisional")

    baseline["hardwareClass"] = hardware_class()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--launches", type=int, default=7, help="process launches per side (default 7)")
    parser.add_argument("--scenario", help="run one scenario instead of all of them")
    parser.add_argument("--go", action="store_true", help="also run the Go side and report the ratio")
    parser.add_argument(
        "--aot",
        action="store_true",
        help="also measure a NativeAOT build of the same emitted assembly (adds a publish, minutes)",
    )
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

    assembly = compile_bench(Path(args.gsc), Path(args.extensions), out)
    measured = summarize(measure(["dotnet", "exec", str(assembly)], args.launches, args.scenario, out, PINNED_TIER_ENV))

    measured_aot: dict[str, dict] = {}
    if args.aot:
        binary = publish_aot(assembly, out)
        measured_aot = summarize(measure([str(binary)], args.launches, args.scenario, out, {}))

    go_measured = summarize(run_go(args.launches)) if args.go else {}

    print(f"hardware class: {hardware_class()}   launches: {args.launches}   jit tier pinned")
    header = f"  {'scenario':<14} {'jit ns/op':>12}"
    if measured_aot:
        header += f" {'aot ns/op':>12}"
    if go_measured:
        header += f" {'go ns/op':>12} {'jit/go':>8}"
        if measured_aot:
            header += f" {'aot/go':>8}"
    print(header)

    for scenario in scenarios:
        name = scenario["name"]
        result = measured.get(name)
        aot_result = measured_aot.get(name)
        if result is None and aot_result is None:
            continue

        line = f"  {name:<14} " + (f"{result['median_ns']:>12.2f}" if result else f"{'-':>12}")
        if measured_aot:
            line += " " + (f"{aot_result['median_ns']:>12.2f}" if aot_result else f"{'-':>12}")

        go_row = scenario.get("go")
        go = go_measured.get(go_row) if go_row else None
        if go_measured:
            if go:
                line += f" {go['median_ns']:>12.2f}"
                line += f" {result['median_ns'] / go['median_ns']:>7.2f}x" if result else f" {'-':>8}"
                if measured_aot:
                    line += f" {aot_result['median_ns'] / go['median_ns']:>7.2f}x" if aot_result else f" {'-':>8}"
            else:
                line += f" {'-':>12} {'-':>8}" + (f" {'-':>8}" if measured_aot else "")

        print(line)

    if args.json:
        Path(args.json).write_text(
            json.dumps(
                {
                    "gsharp": measured,
                    "gsharp_aot": measured_aot,
                    "go": go_measured,
                    "hardwareClass": hardware_class(),
                },
                indent=2,
            )
            + "\n"
        )

    if args.update_baseline:
        path = Path(args.update_baseline)
        baseline = json.loads(path.read_text())
        code = update(baseline, measured, measured_aot, go_measured, scenarios, args.allow_regression)
        if code:
            return code

        path.write_text(json.dumps(baseline, indent=2) + "\n")
        print(f"updated {path}")

    if args.check_baseline:
        baseline = json.loads(Path(args.check_baseline).read_text())
        print("\nwithin-runtime gate:")
        failures = check(baseline, measured, measured_aot, scenarios)
        if failures:
            print(f"\n{failures} scenario(s) regressed past their recorded ceiling.", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
