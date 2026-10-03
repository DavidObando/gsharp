#!/usr/bin/env python3
"""Compile-time and peak-memory budget: G#-built gsc vs C#-built gsc.

Issue #4631 (C6). The compiler is moving to G# source, and the owner's
budget for the G#-built compiler is at most 1.5x the C#-built compiler's
compile time and peak memory (1:1 is the aspiration).

Both compilers compile the SAME input: one gsc response file, normally the
`GSharp.Core.rsp` an SDK build of the migrated tree's `src/Core` writes
(692 `.gs` files). Output paths in the response file are redirected into
the work directory, so the benchmark never touches the tree. Runs
alternate native/migrated so load drift on a shared machine hits both
equally; each run is measured with GNU time (wall seconds, user+system CPU
seconds, maximum resident set size). The verdict compares medians.

Exit status: 0 within budget, 1 over budget, 2 a tool error (a compile
failed, or a measurement could not be taken).
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

# gsc writes a file for each of these; /log: is the compiler debug log (src/Compiler/Program.cs).
OUTPUT_OPTIONS = ("/out:", "/pdb:", "/refout:", "/doc:", "/log:")
METRICS = ("wallSeconds", "cpuSeconds", "maxRssMb")
# The budget applies to time (wall and CPU) and to peak memory.
GATED = ("wallSeconds", "cpuSeconds", "maxRssMb")


class BenchError(Exception):
    """A compile or measurement failure (exit 2)."""


def redirect_outputs(rsp_text: str, directory: Path) -> str:
    """Points every output option of a gsc response file into `directory`.

    Recognizes both spellings a response file uses for a path with whitespace:
    `/out:"a b"` and the whole-token form `"/out:a b"` the SDK's BuildTask writes.
    """
    lines = []
    for line in rsp_text.splitlines():
        stripped = line.strip()
        whole_token_quoted = stripped.startswith('"')
        probe = stripped[1:] if whole_token_quoted else stripped
        option = next((o for o in OUTPUT_OPTIONS if probe.lower().startswith(o)), None)
        if option is None:
            lines.append(line)
            continue
        name = Path(probe[len(option):].strip('"')).name
        if not name:
            # `/log:` with no path means the compiler's default location; nothing to redirect.
            lines.append(line)
            continue
        target = str(directory / ("ref-" + name if option == "/refout:" else name))
        # Quote a path with whitespace so the response-file parser keeps it whole.
        lines.append(f'{option}"{target}"' if any(c.isspace() for c in target) else f"{option}{target}")
    return "\n".join(lines) + "\n"


def resolve_compiler(compiler: str) -> str:
    """Anchors a path-like compiler to the caller's directory.

    The compiler runs with `cwd=--cwd`, so a relative path would otherwise be
    looked up under the project directory. A bare command name is left alone
    for the PATH lookup.
    """
    if os.sep in compiler or (os.altsep and os.altsep in compiler) or compiler.endswith(".dll"):
        return str(Path(compiler).resolve())
    return compiler


def command_for(compiler: str) -> list[str]:
    return ["dotnet", compiler] if compiler.endswith(".dll") else [compiler]


def gnu_time() -> str:
    """The GNU time executable; BenchError when there is none (it measures max RSS)."""
    for candidate in ("/usr/bin/time", shutil.which("gtime"), shutil.which("time")):
        if candidate and os.access(candidate, os.X_OK):
            probe = subprocess.run([candidate, "-f", "%M", "true"], capture_output=True, text=True)
            if probe.returncode == 0 and probe.stderr.strip().isdigit():
                return candidate
    raise BenchError("GNU time (with -f %M) is required; install the 'time' package")


def parse_time(stderr: str) -> dict:
    """Parses the last `BENCH <wall> <user> <sys> <maxrss-kb>` line GNU time wrote."""
    matches = re.findall(r"^BENCH ([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9]+)$", stderr, re.MULTILINE)
    if not matches:
        raise BenchError("no GNU time measurement in the compiler's stderr")
    wall, user, system, rss_kb = matches[-1]
    return {
        "wallSeconds": float(wall),
        "cpuSeconds": round(float(user) + float(system), 2),
        "maxRssMb": round(int(rss_kb) / 1024, 1),
    }


def run_once(compiler: str, rsp_text: str, work: Path, label: str, index: int, cwd: Path) -> dict:
    run_dir = work / f"{label}-{index}"
    run_dir.mkdir(parents=True, exist_ok=True)
    rsp = run_dir / "bench.rsp"
    rsp.write_text(redirect_outputs(rsp_text, run_dir), encoding="utf-8")
    measurement = run_dir / "time.txt"
    command = [gnu_time(), "-o", str(measurement), "-f", "BENCH %e %U %S %M",
               *command_for(compiler), f"@{rsp}"]
    env = dict(os.environ)
    env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
    env["DOTNET_NOLOGO"] = "1"
    env["DOTNET_SKIP_FIRST_TIME_EXPERIENCE"] = "1"
    # GNU time formats numbers per locale; the parser expects '.' decimals.
    env["LC_ALL"] = "C"
    # The compiler's output streams to the log; nothing is buffered here.
    with (run_dir / "compile.log").open("w", encoding="utf-8") as log:
        try:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, env=env, cwd=cwd)
        except OSError as error:
            # A missing executable or working directory is a tool error (exit 2), not a traceback.
            raise BenchError(f"{label} run {index} could not start: {error}") from error
    if result.returncode != 0:
        raise BenchError(f"{label} run {index} failed (exit {result.returncode}); see {run_dir / 'compile.log'}")
    return parse_time(measurement.read_text(encoding="utf-8") if measurement.exists() else "")


def summarize(runs: list[dict]) -> dict:
    return {metric: {"median": statistics.median(run[metric] for run in runs),
                     "min": min(run[metric] for run in runs),
                     "max": max(run[metric] for run in runs)} for metric in METRICS}


def verdict(native: dict, migrated: dict, budget: float) -> dict:
    """Median migrated/native ratios and whether each is within `budget`."""
    exact = {}
    for metric in METRICS:
        base = native[metric]["median"]
        exact[metric] = migrated[metric]["median"] / base if base > 0 else float("inf")
    # Decide on the unrounded ratio; rounding is for display only.
    over = [metric for metric in GATED if exact[metric] > budget]
    ratios = {metric: round(value, 3) if value != float("inf") else value for metric, value in exact.items()}
    return {"ratios": ratios, "budget": budget, "overBudget": over, "withinBudget": not over}


def load_average() -> list[float] | None:
    try:
        return [round(value, 2) for value in os.getloadavg()]
    except OSError:
        return None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--rsp", required=True, type=Path, help="gsc response file (e.g. out/obj/Core/Release/GSharp.Core.rsp)")
    parser.add_argument("--native", required=True, help="C#-built gsc.dll (or an executable)")
    parser.add_argument("--migrated", required=True, help="G#-built gsc.dll (or an executable)")
    parser.add_argument("--runs", type=int, default=5, help="runs per compiler, interleaved (default 5)")
    parser.add_argument("--warmup", type=int, default=1, help="unmeasured runs per compiler first (default 1)")
    parser.add_argument("--budget", type=float, default=1.5, help="maximum migrated/native median ratio (default 1.5)")
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--cwd", type=Path, default=Path.cwd(),
                        help="directory relative source paths in the response file resolve against "
                             "(the project directory, e.g. <tree>/src/Core; default: current directory)")
    args = parser.parse_args(argv)

    if args.runs < 1:
        parser.error("--runs must be at least 1")
    if args.warmup < 0:
        parser.error("--warmup must not be negative")
    if not 0 < args.budget < float("inf"):  # also rejects nan, which would disable the gate
        parser.error("--budget must be a positive, finite number")
    args.native = resolve_compiler(args.native)
    args.migrated = resolve_compiler(args.migrated)
    work = args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    rsp_text = args.rsp.read_text(encoding="utf-8-sig")
    report: dict = {
        "rsp": str(args.rsp), "nativeCompiler": args.native, "migratedCompiler": args.migrated,
        "runs": args.runs, "warmup": args.warmup, "host": platform.node(),
        "cpus": os.cpu_count(), "loadBefore": load_average(),
    }
    try:
        for index in range(args.warmup):
            run_once(args.native, rsp_text, work, "warmup-native", index, args.cwd)
            run_once(args.migrated, rsp_text, work, "warmup-migrated", index, args.cwd)
        native_runs, migrated_runs = [], []
        for index in range(args.runs):
            # Alternate which compiler goes first so neither always runs
            # on a warmer (or busier) machine.
            order = [("native", args.native, native_runs), ("migrated", args.migrated, migrated_runs)]
            if index % 2:
                order.reverse()
            for label, compiler, sink in order:
                sink.append(run_once(compiler, rsp_text, work, label, index, args.cwd))
    except BenchError as error:
        report["error"] = str(error)
        (work / "bench-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"selfhost-bench: {error}", file=sys.stderr)
        return 2

    report["loadAfter"] = load_average()
    report["nativeRuns"], report["migratedRuns"] = native_runs, migrated_runs
    report["native"], report["migrated"] = summarize(native_runs), summarize(migrated_runs)
    report["verdict"] = verdict(report["native"], report["migrated"], args.budget)
    (work / "bench-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    for metric in METRICS:
        print(f"{metric:12} native {report['native'][metric]['median']:>9} "
              f"migrated {report['migrated'][metric]['median']:>9} "
              f"ratio {report['verdict']['ratios'][metric]}")
    within = report["verdict"]["withinBudget"]
    print(f"compiler budget {args.budget}x: " + ("WITHIN" if within else
          "OVER (" + ", ".join(report["verdict"]["overBudget"]) + ")"))
    return 0 if within else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
