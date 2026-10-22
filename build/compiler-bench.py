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

Parity: every file the compiler writes into the staging directory (reference
assembly, PDB, XML documentation, any sidecar such as runtimeconfig.json) and
the diagnostics stream (raw bytes, no decoding or newline translation; only the
run directory path is replaced) must be byte-identical, and present in both
runs. The implementation DLL is compared as raw bytes except for these
exemptions, reported by name; each is a value a deterministic build derives from
the rest of the file, so a real code change cannot hide in it:
  - timestamp: the COFF TimeDateStamp (a hash when deterministic);
  - checksum: the PE optional-header checksum (a function of every other byte);
  - mvid: the 16-byte module version id (a content hash);
  - debug-directory: the 4-byte TimeDateStamp of each debug directory entry;
  - debug-payload: the 16-byte GUID of a CodeView entry (type 2) and the hash
    of a PdbChecksum entry (type 19).
Everything else is compared exactly, including debug directory types, sizes and
pointers, the CodeView age and path, and EmbeddedPortablePdb (type 17) payloads,
which hold the whole compressed PDB. A size difference always fails. Later
baseline runs are a strict control with no exemption at all. A tolerated
difference is a bounded statement, not proof of equal code: the check only says
nothing outside those fields moved.

Exit status: 0 outputs match, 1 an unexpected output difference, 2 a tool
error (a compile failed, or a measurement could not be taken).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import re
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
    # With a portable /debug and no /pdb, gsc still writes "<out>.pdb" beside the
    # implementation DLL (src/Compiler/Program.gs, sidecar PDB default).
    if "pdb" not in found and "out" in found:
        found["pdb"] = str(Path(found["out"]).with_suffix(".pdb"))
    return found


def hello_rsp(template: str, source: Path) -> str:
    """Keeps the option lines of `template`, replacing its source files with `source`."""
    # Source lines end in .gs; on Linux an absolute source path also starts with "/".
    lines = [line for line in template.splitlines()
             if line.strip() and not line.strip().strip('"').lower().endswith(".gs")]
    # Quote with the response-file tokenizer's syntax (a doubled quote inside quotes),
    # so a path with spaces stays one token.
    quoted = '"' + str(source.resolve()).replace('"', '""') + '"'
    return "\n".join([*lines, quoted]) + "\n"


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
            for index in range(size // 28):
                entry = start + index * 28
                # Only the entry's TimeDateStamp is hash-derived; type, size and
                # pointers must match byte for byte.
                regions.append(("debug-directory", entry + 4, entry + 8))
                kind, length, raw = u32(data, entry + 12), u32(data, entry + 16), u32(data, entry + 24)
                if kind == 2 and length >= 24 and data[raw:raw + 4] == b"RSDS":
                    # CodeView: signature, GUID, age, path. Only the GUID is content-derived.
                    regions.append(("debug-payload", raw + 4, raw + 20))
                elif kind == 19 and length:
                    # PdbChecksum: algorithm name, NUL, then the hash of the PDB.
                    nul = data.find(b"\0", raw, raw + length)
                    if nul >= 0:
                        regions.append(("debug-payload", nul + 1, raw + length))
                # Any other type, notably 17 (EmbeddedPortablePdb, the whole compressed
                # PDB), is compared byte for byte.
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
    result: dict = {"exact": {}, "implementation": None, "missing": []}
    # An artifact present in one run and absent from the other is a difference, and
    # both runs must have produced an implementation DLL.
    for kind in sorted(set(first) | set(second)):
        if (kind in first) != (kind in second):
            side = "candidate or later run" if kind in first else "first run"
            result["missing"].append(f"{kind} output is absent from the {side}")
    if "out" not in first or "out" not in second:
        result["missing"].append("an implementation DLL is required in both runs")
    for kind in sorted((set(first) & set(second)) - {"out"}):
        result["exact"][kind] = Path(first[kind]).read_bytes() == Path(second[kind]).read_bytes()
    if "out" in first and "out" in second:
        left, right = Path(first["out"]).read_bytes(), Path(second["out"]).read_bytes()
        regions, notes = identity_regions(left)
        outcome = compare_bytes(left, right, regions)
        outcome["notes"] = notes
        result["implementation"] = outcome

    def log(directory: Path) -> bytes:
        # Raw bytes: no decoding or newline translation. Only the run directory path is replaced.
        return (directory / "compile.log").read_bytes().replace(os.fsencode(str(directory)), b"<run>")

    result["diagnosticsIdentical"] = log(first_dir) == log(second_dir)
    return result


def unexpected(comparison: dict, strict: bool = False) -> list[str]:
    """The failures of a comparison.

    `strict` is for the baseline control. Every run stages its outputs at the same
    path, so two runs of one deterministic compiler are byte-identical, identity
    groups included (the PDB path feeds the content hash). Only the
    baseline-vs-candidate comparison may differ in the identity groups.
    """
    problems = list(comparison["missing"])
    problems += [f"{kind} differs" for kind, same in comparison["exact"].items() if not same]
    if not comparison["diagnosticsIdentical"]:
        problems.append("diagnostics differ")
    impl = comparison["implementation"]
    if impl and not impl["identical"]:
        if strict:
            problems.append("implementation DLL differs"
                            + (f" in {', '.join(impl['groups'])}" if impl["groups"] else ""))
        elif impl["sizeDiffers"] or impl["otherBytes"]:
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
        # Drop the large staged outputs but keep compile.log, which the error names.
        shutil.rmtree(stage, ignore_errors=True)
        raise BenchError(f"{label} run {index} failed (exit {result.returncode}); see {run_dir / 'compile.log'}")
    measured = bench.parse_time((run_dir / "time.txt").read_text(encoding="utf-8"))
    measured["phases"] = read_phases(phases)
    measured["outputs"] = {}
    known = {str(Path(path)): kind for kind, path in output_paths(redirected).items()}
    for staged in sorted(stage.rglob("*")):
        if not staged.is_file():
            continue
        relative = staged.relative_to(stage)
        # A file no option names (for example <out>.runtimeconfig.json) is compared too.
        kind = known.get(str(staged), f"file:{relative.as_posix()}")
        target = run_dir / "outputs" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staged), target)
        measured["outputs"][kind] = str(target)
    shutil.rmtree(stage, ignore_errors=True)
    log_path = run_dir / "compile.log"
    log_path.write_bytes(log_path.read_bytes().replace(os.fsencode(str(stage)), b"<out>"))
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
    impls = [c["implementation"] for c in parity["candidate"] if c["implementation"]]
    if impls:
        groups = sorted({g for i in impls for g in i["groups"]})
        identical = all(i["identical"] for i in impls)
        print(f"implementation DLL ({len(impls)} candidate runs): "
              f"{'identical' if identical else 'differs in ' + (', '.join(groups) or 'none')}"
              f" ({max(i['otherBytes'] for i in impls)} bytes outside identity groups)")
        for note in impls[0]["notes"]:
            print(f"  note: {note}")
    controls = parity["control"]
    if controls:
        print(f"baseline-vs-baseline control ({len(controls)} runs): "
              + ("identical" if not any(unexpected(c, strict=True) for c in controls) else "DIFFERS"))
    print("parity: " + ("OK" if not cell["problems"] else "FAILED - " + "; ".join(cell["problems"])))


def prune_outputs(run: dict) -> None:
    """Deletes a run's large outputs once nothing needs them; logs stay."""
    for path in run["outputs"].values():
        Path(path).unlink(missing_ok=True)


CELL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def cell_directory(work: Path, name: str) -> Path:
    """The cell's own directory, directly under the work root; the script deletes it later."""
    if not CELL_NAME.fullmatch(name) or ".." in name:
        raise BenchError(f"cell name {name!r} must be letters, digits, '.', '_' or '-' (no path separators)")
    directory = (work / name).resolve()
    if directory.parent != work.resolve():
        raise BenchError(f"cell {name!r} does not resolve directly under the work root")
    if directory.exists():
        raise BenchError(f"cell directory {directory} already exists")
    return directory


def run_cell(name: str, rsp_text: str, cwd: Path, args: argparse.Namespace, work: Path) -> dict:
    cell_work = cell_directory(work, name)
    runs: dict[str, list[dict]] = {"baseline": [], "candidate": []}
    compilers = {"baseline": args.baseline, "candidate": args.candidate}
    parity: dict = {"candidate": [], "control": []}
    problems: list[str] = []
    try:
        for index in range(args.warmup):
            for label in ("baseline", "candidate"):
                run_once(compilers[label], rsp_text, cell_work, f"warmup-{label}", index, cwd)
                shutil.rmtree(cell_work / f"warmup-{label}-{index}", ignore_errors=True)
        for index in range(args.runs):
            # Alternate which compiler goes first so neither always runs on a warmer machine.
            order = ["baseline", "candidate"] if index % 2 == 0 else ["candidate", "baseline"]
            for label in order:
                runs[label].append(run_once(compilers[label], rsp_text, cell_work, label, index, cwd))
            # Every measured run is compared with the first baseline run, whose outputs
            # are kept until the cell ends. Candidate runs use the identity-group
            # tolerance; later baseline runs are the strict control.
            base0 = runs["baseline"][0]
            base_dir = cell_work / "baseline-0"
            candidate = compare_runs(base0["outputs"], runs["candidate"][index]["outputs"],
                                     base_dir, cell_work / f"candidate-{index}")
            parity["candidate"].append(candidate)
            problems += [f"candidate run {index}: {p}" for p in unexpected(candidate)]
            if index >= 1:
                control = compare_runs(base0["outputs"], runs["baseline"][index]["outputs"],
                                       base_dir, cell_work / f"baseline-{index}")
                parity["control"].append(control)
                problems += [f"baseline control run {index} (baseline is not deterministic): {p}"
                             for p in unexpected(control, strict=True)]
            if not args.keep:
                prune_outputs(runs["candidate"][index])
                if index >= 1:
                    prune_outputs(runs["baseline"][index])
    except BenchError:
        # Keep the logs a failure message points at; drop the large outputs.
        for measured in (*runs["baseline"], *runs["candidate"]):
            prune_outputs(measured)
        raise
    cell = {"cwd": str(cwd), "baseline": summarize(runs["baseline"]), "candidate": summarize(runs["candidate"]),
            "parity": parity, "problems": problems,
            "baselineRuns": [{m: r[m] for m in METRICS} for r in runs["baseline"]],
            "candidateRuns": [{m: r[m] for m in METRICS} for r in runs["candidate"]]}
    if not args.keep:
        shutil.rmtree(cell_work, ignore_errors=True)
    return cell


def write_report(work: Path, report: dict) -> None:
    (work / "compiler-bench-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


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
    created = False
    try:
        args.baseline = bench.resolve_compiler(args.baseline)
        args.candidate = bench.resolve_compiler(args.candidate)
        # The script owns the work root: a non-empty directory may hold someone else's files.
        if work.exists() and (not work.is_dir() or any(work.iterdir())):
            raise BenchError(f"work root {work} exists and is not an empty directory")
        work.mkdir(parents=True, exist_ok=True)
        created = True
        cells = [(name, load_rsp(Path(rsp)), Path(cwd).resolve()) for name, rsp, cwd in args.cell]
        if args.hello:
            cells.insert(0, ("hello", hello_rsp(cells[0][1], args.hello), cells[0][2]))
        names = [name for name, _, _ in cells]
        if len(set(names)) != len(names):
            raise BenchError(f"cell names must be unique: {names}")
        for name, rsp_text, cwd in cells:
            report["cells"][name] = run_cell(name, rsp_text, cwd, args, work)
    except BenchError as error:
        report["error"] = str(error)
        print(f"compiler-bench: {error}", file=sys.stderr)
        if created:  # never write into a directory that was rejected
            write_report(work, report)
        return 2
    report["loadAfter"] = bench.load_average()
    for name, cell in report["cells"].items():
        print_cell(name, cell)
    write_report(work, report)
    failed = [name for name, cell in report["cells"].items() if cell["problems"]]
    if failed:
        print(f"\ncompiler-bench: unexpected output differences in: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
