#!/usr/bin/env python3
"""Interleaved before/after compiler benchmark with output parity checks.

Issue #5127 (Q9). A performance change to gsc needs the same evidence each
time: a baseline compiler and a candidate compiler run interleaved on the same
inputs, medians and ranges for wall time, CPU time and peak RSS, the
GSHARP_MEASURE_PHASES counters, and proof the outputs match.

Each input ("cell") is a gsc response file plus the project directory its
relative paths resolve against. A hello-world cell can be derived from the
first cell's options. Output options are redirected into a work root under
~/.cache; the work root may not be under /tmp unless --allow-tmp is given.

Parity: the reference assembly, PDB, XML documentation and diagnostics (the
compiler's output stream) must be byte-identical. The implementation DLL may
differ in the groups a deterministic build derives from its content: the COFF
timestamp, the PE checksum, the MVID and the debug directory with its payloads. Those groups are
reported by name. The first two baseline runs are compared as a control; a
difference outside those groups, in the control or the candidate, fails.

Exit status: 0 outputs match, 1 an unexpected output difference, 2 a tool
error (a compile failed, or a measurement could not be taken).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import shutil
import statistics
import struct
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load build/{file}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


bench = _load("selfhost_bench", "selfhost-bench.py")
pe = _load("selfhost_pe", "selfhost_pe.py")

BenchError = bench.BenchError
METRICS = bench.METRICS
KIND_BY_OPTION = {"/out:": "out", "/pdb:": "pdb", "/refout:": "refout", "/doc:": "doc"}
# Kinds compared byte for byte, in addition to the diagnostics stream.
EXACT_KINDS = ("pdb", "refout", "doc")


def default_work_root() -> Path:
    return Path.home() / ".cache" / "q9-bench" / time.strftime("run-%Y%m%d-%H%M%S")


def refuse_tmp(work: Path, allow: bool) -> None:
    """/tmp is a small shared tmpfs; a Core replay writes hundreds of MB."""
    if allow:
        return
    for root in {Path("/tmp").resolve(), Path(os.environ.get("TMPDIR", "/tmp")).resolve()}:
        if work == root or root in work.parents:
            raise BenchError(f"refusing to write under {root}; use a work root under ~/.cache "
                             "(or pass --allow-tmp)")


def output_paths(rsp_text: str) -> dict[str, str]:
    """The kind -> path map of a (redirected) response file's output options."""
    found: dict[str, str] = {}
    for line in rsp_text.splitlines():
        probe = line.strip().lstrip('"')
        for option, kind in KIND_BY_OPTION.items():
            if probe.lower().startswith(option):
                found[kind] = probe[len(option):].strip('"')
    return found


def hello_rsp(template: str, source: Path) -> str:
    """Keeps the option lines of `template`, replacing its source files with `source`."""
    # Source lines end in .gs; on Linux an absolute source path also starts with "/".
    lines = [line for line in template.splitlines()
             if line.strip() and not line.strip().strip('"').lower().endswith(".gs")]
    return "\n".join([*lines, str(source.resolve())]) + "\n"


def load_rsp(path: Path) -> str:
    # The SDK writes a BOM; utf-8-sig drops it so the first option still parses.
    return path.read_text(encoding="utf-8-sig")


def u16(data: bytes, offset: int) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def identity_regions(data: bytes) -> tuple[list[tuple[str, int, int]], list[str]]:
    """Byte regions of a PE that a deterministic build derives from its content.

    Returns (regions, notes). A region is (group, start, end). What cannot be
    located is listed in notes, and differing bytes outside the located
    regions count as unexpected.
    """
    regions: list[tuple[str, int, int]] = []
    notes: list[str] = []
    try:
        if data[:2] != b"MZ":
            raise ValueError("no MZ header")
        header = u32(data, 0x3C)
        if data[header:header + 4] != b"PE\0\0":
            raise ValueError("no PE signature")
        section_count = u16(data, header + 6)
        optional_size = u16(data, header + 20)
        optional = header + 24
        magic = u16(data, optional)
        regions.append(("timestamp", header + 8, header + 12))  # deterministic builds hash it
        regions.append(("checksum", optional + 64, optional + 68))
        directories = optional + (112 if magic == 0x20B else 96)
        table = optional + optional_size
        sections = []
        for index in range(section_count):
            entry = table + index * 40
            sections.append((u32(data, entry + 12), max(u32(data, entry + 8), u32(data, entry + 16)),
                             u32(data, entry + 20)))

        def to_offset(rva: int) -> int:
            for virtual, span, raw in sections:
                if virtual <= rva < virtual + span:
                    return raw + rva - virtual
            raise ValueError(f"RVA {rva:#x} is in no section")

        rva, size = u32(data, directories + 6 * 8), u32(data, directories + 6 * 8 + 4)
        if rva and size:
            start = to_offset(rva)
            regions.append(("debug-directory", start, start + size))
            for index in range(size // 28):
                entry = start + index * 28
                length, raw = u32(data, entry + 16), u32(data, entry + 24)
                if length and raw:
                    regions.append(("debug-payload", raw, raw + length))
    except (ValueError, struct.error) as error:
        notes.append(f"PE header not fully located: {error}")
    try:
        mvid = pe.inspect_layout(data).mvid_offset
        regions.append(("mvid", mvid, mvid + 16))
    except Exception as error:  # selfhost_pe fails closed on shapes it does not model
        notes.append(f"MVID not located: {error}")
    return regions, notes


def compare_bytes(left: bytes, right: bytes, regions: list[tuple[str, int, int]]) -> dict:
    """Which identity groups differ, and how many differing bytes fall outside them."""
    if len(left) != len(right):
        return {"identical": False, "sizeDiffers": True, "groups": [], "otherBytes": abs(len(left) - len(right))}
    groups: set[str] = set()
    other = 0
    if left != right:
        for offset, (a, b) in enumerate(zip(left, right)):
            if a == b:
                continue
            owner = next((name for name, start, end in regions if start <= offset < end), None)
            if owner:
                groups.add(owner)
            else:
                other += 1
    return {"identical": left == right, "sizeDiffers": False, "groups": sorted(groups), "otherBytes": other}


def compare_runs(first: dict, second: dict, first_dir: Path, second_dir: Path) -> dict:
    """Compares the outputs and diagnostics of two runs; each dict is a run's `outputs` map."""
    result: dict = {"exact": {}, "implementation": None}
    for kind in EXACT_KINDS:
        if kind in first and kind in second:
            result["exact"][kind] = Path(first[kind]).read_bytes() == Path(second[kind]).read_bytes()
    if "out" in first and "out" in second:
        left, right = Path(first["out"]).read_bytes(), Path(second["out"]).read_bytes()
        regions, notes = identity_regions(left)
        outcome = compare_bytes(left, right, regions)
        outcome["notes"] = notes
        result["implementation"] = outcome

    def log(directory: Path) -> str:
        text = (directory / "compile.log").read_text(encoding="utf-8", errors="replace")
        return text.replace(str(directory), "<run>")  # staged output paths are already "<out>"

    result["diagnosticsIdentical"] = log(first_dir) == log(second_dir)
    return result


def unexpected(comparison: dict) -> list[str]:
    problems = [f"{kind} differs" for kind, same in comparison["exact"].items() if not same]
    if not comparison["diagnosticsIdentical"]:
        problems.append("diagnostics differ")
    impl = comparison["implementation"]
    if impl and not impl["identical"] and (impl["sizeDiffers"] or impl["otherBytes"]):
        problems.append("implementation DLL differs outside the identity groups"
                        + (" (size)" if impl["sizeDiffers"] else f" ({impl['otherBytes']} bytes)"))
    return problems


def read_phases(path: Path) -> dict:
    """Aggregates a GSHARP_MEASURE_PHASES file by phase name (count, wall ms, alloc bytes)."""
    if not path.exists():
        return {"phases": {}, "counters": {}}
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    phases: dict[str, dict] = {}
    for phase in document.get("Phases", []):
        entry = phases.setdefault(phase["Name"], {"count": 0, "wallMs": 0.0, "allocBytes": 0})
        entry["count"] += 1
        entry["wallMs"] += phase.get("ElapsedMilliseconds", 0.0)
        entry["allocBytes"] += phase.get("ProcessAllocatedBytes", 0)
    return {"phases": phases, "counters": document.get("Counters", {})}


def run_once(compiler: str, rsp_text: str, work: Path, label: str, index: int, cwd: Path) -> dict:
    run_dir = work / f"{label}-{index}"
    run_dir.mkdir(parents=True, exist_ok=True)
    # Every run writes to the same staging path: the PDB path and the content hash
    # derived from it would differ between runs in different directories.
    stage = work / "stage"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    redirected = bench.redirect_outputs(rsp_text, stage)
    (run_dir / "bench.rsp").write_text(redirected, encoding="utf-8")
    phases = run_dir / "phases.json"
    command = [bench.gnu_time(), "-o", str(run_dir / "time.txt"), "-f", "BENCH %e %U %S %M",
               *bench.command_for(compiler), f"@{run_dir / 'bench.rsp'}"]
    env = dict(os.environ, DOTNET_CLI_TELEMETRY_OPTOUT="1", DOTNET_NOLOGO="1",
               DOTNET_SKIP_FIRST_TIME_EXPERIENCE="1", LC_ALL="C",
               GSHARP_MEASURE_PHASES=str(phases), TMPDIR=str(work))
    with (run_dir / "compile.log").open("w", encoding="utf-8") as log:
        try:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, env=env, cwd=cwd)
        except OSError as error:
            raise BenchError(f"{label} run {index} could not start: {error}") from error
    if result.returncode != 0:
        raise BenchError(f"{label} run {index} failed (exit {result.returncode}); see {run_dir / 'compile.log'}")
    measured = bench.parse_time((run_dir / "time.txt").read_text(encoding="utf-8"))
    measured["phases"] = read_phases(phases)
    measured["outputs"] = {}
    for kind, path in output_paths(redirected).items():
        if Path(path).exists():
            target = run_dir / ("ref-" + Path(path).name if kind == "refout" else Path(path).name)
            shutil.move(path, target)
            measured["outputs"][kind] = str(target)
    shutil.rmtree(stage, ignore_errors=True)
    log_path = run_dir / "compile.log"
    log_path.write_text(log_path.read_text(encoding="utf-8", errors="replace").replace(str(stage), "<out>"),
                        encoding="utf-8")
    return measured


def summarize(runs: list[dict]) -> dict:
    summary = bench.summarize(runs)
    names = sorted({name for run in runs for name in run["phases"]["phases"]})
    summary["phases"] = {
        name: {"count": statistics.median(r["phases"]["phases"].get(name, {}).get("count", 0) for r in runs),
               "wallMs": statistics.median(r["phases"]["phases"].get(name, {}).get("wallMs", 0.0) for r in runs),
               "allocMiB": round(statistics.median(
                   r["phases"]["phases"].get(name, {}).get("allocBytes", 0) for r in runs) / 1048576, 1)}
        for name in names}
    counters = sorted({name for run in runs for name in run["phases"]["counters"]})
    summary["counters"] = {name: statistics.median(r["phases"]["counters"].get(name, 0) for r in runs)
                           for name in counters}
    return summary


def ratio(candidate: float, baseline: float) -> str:
    return f"{candidate / baseline:.3f}" if baseline else "n/a"


def print_cell(name: str, cell: dict) -> None:
    base, cand = cell["baseline"], cell["candidate"]
    print(f"\n== {name} ==")
    print(f"{'metric':12} {'baseline median (min-max)':>34} {'candidate median (min-max)':>34} ratio")
    for metric in METRICS:
        b, c = base[metric], cand[metric]
        print(f"{metric:12} {b['median']:>12} ({b['min']}-{b['max']}) {c['median']:>12} ({c['min']}-{c['max']})"
              f" {ratio(c['median'], b['median'])}")
    names = sorted(set(base["phases"]) | set(cand["phases"]))
    if names:
        print(f"{'phase':36} {'count':>6} {'base ms':>10} {'cand ms':>10} ratio")
        for phase in names:
            b = base["phases"].get(phase, {"wallMs": 0.0})
            c = cand["phases"].get(phase, {"count": 0, "wallMs": 0.0})
            print(f"{phase:36} {c.get('count', 0):>6} {b['wallMs']:>10.1f} {c['wallMs']:>10.1f} "
                  f"{ratio(c['wallMs'], b['wallMs'])}")
    for counter in sorted(set(base["counters"]) | set(cand["counters"])):
        print(f"counter {counter}: baseline {base['counters'].get(counter, 0)} "
              f"candidate {cand['counters'].get(counter, 0)}")
    parity = cell["parity"]
    impl = parity["candidate"]["implementation"]
    if impl:
        groups = ", ".join(impl["groups"]) or "none"
        print(f"implementation DLL: {'identical' if impl['identical'] else 'differs in ' + groups}"
              f" ({impl['otherBytes']} bytes outside identity groups)")
        for note in impl["notes"]:
            print(f"  note: {note}")
    control = parity.get("control")
    if control and control["implementation"]:
        c_impl = control["implementation"]
        print("baseline-vs-baseline control: "
              + ("identical" if c_impl["identical"] else "differs in " + (", ".join(c_impl["groups"]) or "no group")))
    print("parity: " + ("OK" if not cell["problems"] else "FAILED - " + "; ".join(cell["problems"])))


def prune_outputs(runs: list[dict], index: int) -> None:
    """Deletes a run's large outputs once nothing needs them."""
    for path in runs[index]["outputs"].values():
        Path(path).unlink(missing_ok=True)


def run_cell(name: str, rsp_text: str, cwd: Path, args: argparse.Namespace, work: Path) -> dict:
    cell_work = work / name
    runs: dict[str, list[dict]] = {"baseline": [], "candidate": []}
    compilers = {"baseline": args.baseline, "candidate": args.candidate}
    for index in range(args.warmup):
        for label in ("baseline", "candidate"):
            run_once(compilers[label], rsp_text, cell_work, f"warmup-{label}", index, cwd)
            shutil.rmtree(cell_work / f"warmup-{label}-{index}", ignore_errors=True)
    for index in range(args.runs):
        # Alternate which compiler goes first so neither always runs on a warmer machine.
        order = ["baseline", "candidate"] if index % 2 == 0 else ["candidate", "baseline"]
        for label in order:
            runs[label].append(run_once(compilers[label], rsp_text, cell_work, label, index, cwd))
            # The first two baseline runs and the first candidate run feed the parity check.
            if index >= (2 if label == "baseline" else 1) and not args.keep:
                prune_outputs(runs[label], index)
    first_base, first_cand = cell_work / "baseline-0", cell_work / "candidate-0"
    parity: dict = {"candidate": compare_runs(runs["baseline"][0]["outputs"], runs["candidate"][0]["outputs"],
                                              first_base, first_cand)}
    problems = [f"candidate: {p}" for p in unexpected(parity["candidate"])]
    if args.runs >= 2:
        parity["control"] = compare_runs(runs["baseline"][0]["outputs"], runs["baseline"][1]["outputs"],
                                         first_base, cell_work / "baseline-1")
        problems += [f"baseline control (nondeterministic baseline): {p}" for p in unexpected(parity["control"])]
    cell = {"cwd": str(cwd), "baseline": summarize(runs["baseline"]), "candidate": summarize(runs["candidate"]),
            "parity": parity, "problems": problems,
            "baselineRuns": [{m: r[m] for m in METRICS} for r in runs["baseline"]],
            "candidateRuns": [{m: r[m] for m in METRICS} for r in runs["candidate"]]}
    if not args.keep:
        shutil.rmtree(cell_work, ignore_errors=True)
    return cell


def finish(work: Path, report: dict, keep: bool) -> None:
    if not work.exists():
        return
    (work / "compiler-bench-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not keep:
        for child in work.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--baseline", required=True, help="baseline gsc.dll (or an executable)")
    parser.add_argument("--candidate", required=True, help="candidate gsc.dll (or an executable)")
    parser.add_argument("--cell", action="append", nargs=3, default=[], metavar=("NAME", "RSP", "CWD"),
                        help="an input: a response file and the project directory it resolves against")
    parser.add_argument("--hello", type=Path, help="a hello-world .gs file; its options come from the first --cell")
    parser.add_argument("--runs", type=int, default=5, help="measured runs per compiler, interleaved (default 5)")
    parser.add_argument("--warmup", type=int, default=1, help="unmeasured runs per compiler first (default 1)")
    parser.add_argument("--work", type=Path, default=None, help="work root (default ~/.cache/q9-bench/run-<time>)")
    parser.add_argument("--allow-tmp", action="store_true", help="allow a work root under /tmp (not for large cells)")
    parser.add_argument("--keep", action="store_true", help="keep the work root and every run's outputs")
    args = parser.parse_args(argv)
    if args.runs < 1:
        parser.error("--runs must be at least 1")
    if args.warmup < 0:
        parser.error("--warmup must not be negative")
    if not args.cell:
        parser.error("at least one --cell is required")
    if args.hello and not args.hello.is_file():
        parser.error(f"--hello file not found: {args.hello}")

    work = (args.work or default_work_root()).expanduser().resolve()
    report: dict = {"baseline": args.baseline, "candidate": args.candidate, "runs": args.runs,
                    "warmup": args.warmup, "host": platform.node(), "cpus": os.cpu_count(),
                    "loadBefore": bench.load_average(), "cells": {}}
    try:
        refuse_tmp(work, args.allow_tmp)
    except BenchError as error:
        print(f"compiler-bench: {error}", file=sys.stderr)
        return 2
    try:
        args.baseline = bench.resolve_compiler(args.baseline)
        args.candidate = bench.resolve_compiler(args.candidate)
        work.mkdir(parents=True, exist_ok=True)
        cells = [(name, load_rsp(Path(rsp)), Path(cwd).resolve()) for name, rsp, cwd in args.cell]
        if args.hello:
            cells.insert(0, ("hello", hello_rsp(cells[0][1], args.hello), cells[0][2]))
        for name, rsp_text, cwd in cells:
            report["cells"][name] = run_cell(name, rsp_text, cwd, args, work)
    except BenchError as error:
        report["error"] = str(error)
        print(f"compiler-bench: {error}", file=sys.stderr)
        finish(work, report, args.keep)
        return 2
    report["loadAfter"] = bench.load_average()
    for name, cell in report["cells"].items():
        print_cell(name, cell)
    finish(work, report, args.keep)
    failed = [name for name, cell in report["cells"].items() if cell["problems"]]
    if failed:
        print(f"\ncompiler-bench: unexpected output differences in: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
