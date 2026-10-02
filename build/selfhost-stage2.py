#!/usr/bin/env python3
"""Stage-2 self-host equivalence check for a cs2gs-migrated (G#) tree.

Issue #4631 (C3/C4). Given a migrated tree prepared by
build/selfhost-pack-stage1.py, the stage-0 (C#-built) SDK package and the
stage-1 (G#-source, stage-0-built) SDK package, this script:

  1. builds the requested projects with stage 0  -> the stage-1 assemblies
  2. builds the same projects, in the SAME tree path, with stage 1
                                                -> the stage-2 assemblies
  3. compares each assembly pair: full-file SHA-256, and the IL+metadata
     hash with the MVID zeroed (build/selfhost/PeContentHash.cs, the same
     hash RefactoringBaselineTests pins)
  4. optionally runs test projects while pinned to stage 1, so every
     assembly they compile against is a stage-2 assembly.

Both builds run from the same absolute paths with the same isolated
NuGet cache layout, so any byte that differs comes from the compiler (or
the SDK task) that produced it. The verdict is "equivalent" only if every
IL+metadata hash matches; a full-file difference with matching IL+metadata
is reported, not hidden.

Exit status: 0 equivalent (and tests passed), 1 not equivalent or a test
failed, 2 a build or tool error.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location("selfhost_pack_stage1", HERE / "selfhost-pack-stage1.py")
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("cannot load build/selfhost-pack-stage1.py")
packer = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(packer)

HASH_TOOL = HERE / "selfhost" / "PeContentHash.cs"
DEFAULT_PROJECTS = ["src/Core/Core.gsproj"]
DEFAULT_ASSEMBLIES = ["out/bin/Release/Core/GSharp.Core.dll"]


class Stage2Error(Exception):
    """A build or tool failure (exit 2)."""


def run(command: list[str], cwd: Path, env: dict, log: Path) -> tuple[int, float]:
    started = time.monotonic()
    with log.open("a", encoding="utf-8") as handle:
        handle.write("$ " + " ".join(command) + "\n")
        handle.flush()
        result = subprocess.run(command, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT)
    return result.returncode, time.monotonic() - started


def stage_env(work: Path, stage: str) -> dict:
    env = dict(os.environ)
    # Same cache path in both stages would let stage 2 reuse an extracted
    # stage-0 package of the same version; the versions differ by
    # construction, but the caches are separated anyway so a stale extract
    # can never leak across stages.
    env["NUGET_PACKAGES"] = str(work / f"nuget-{stage}")
    env["TMPDIR"] = str(work / "tmp")
    env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
    env["MSBUILDDISABLENODEREUSE"] = "1"
    (work / "tmp").mkdir(parents=True, exist_ok=True)
    return env


def clean_outputs(tree: Path) -> None:
    for name in ("out",):
        shutil.rmtree(tree / name, ignore_errors=True)


def pin(tree: Path, nupkg: Path) -> str:
    version = packer.package_version(nupkg)
    packer.stage_feed(tree, packer.sibling_nupkgs(nupkg, version))
    packer.pin_global_json(tree, version)
    return version


def build_stage(tree: Path, stage: str, nupkg: Path, projects: list[str], assemblies: list[str],
                work: Path, config: str) -> dict:
    version = pin(tree, nupkg)
    clean_outputs(tree)
    env = stage_env(work, stage)
    log = work / f"{stage}.build.log"
    log.write_text("", encoding="utf-8")
    seconds = 0.0
    for project in projects:
        code, elapsed = run(["dotnet", "build", project, "-c", config, "-nodeReuse:false"], tree, env, log)
        seconds += elapsed
        if code != 0:
            raise Stage2Error(f"{stage}: dotnet build {project} failed (exit {code}); see {log}")
    target = work / stage
    shutil.rmtree(target, ignore_errors=True)
    copied = {}
    for assembly in assemblies:
        source = tree / assembly
        if not source.is_file():
            raise Stage2Error(f"{stage}: expected output {assembly} was not produced")
        destination = target / assembly
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        pdb = source.with_suffix(".pdb")
        if pdb.is_file():
            shutil.copy2(pdb, destination.with_suffix(".pdb"))
        copied[assembly] = str(destination)
    return {"sdkVersion": version, "buildSeconds": round(seconds, 1), "assemblies": copied}


def content_hashes(paths: list[str], work: Path) -> dict[str, tuple[str, int]]:
    env = stage_env(work, "hash")
    result = subprocess.run(["dotnet", "run", str(HASH_TOOL), "--", *paths], cwd=HERE / "selfhost",
                            env=env, capture_output=True, text=True)
    if result.returncode != 0:
        raise Stage2Error("PeContentHash failed:\n" + result.stdout + result.stderr)
    hashes = {}
    for line in result.stdout.splitlines():
        digest, methods, path = line.split("  ", 2)
        hashes[path] = (digest, int(methods))
    return hashes


def file_sha256(path: str) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest().upper()


def compare(stage1: dict, stage2: dict, work: Path) -> list[dict]:
    paths = list(stage1["assemblies"].values()) + list(stage2["assemblies"].values())
    hashes = content_hashes(paths, work)
    rows = []
    for assembly, first in stage1["assemblies"].items():
        second = stage2["assemblies"][assembly]
        rows.append({
            "assembly": assembly,
            "stage1": {"sha256": file_sha256(first), "content": hashes[first][0], "methods": hashes[first][1]},
            "stage2": {"sha256": file_sha256(second), "content": hashes[second][0], "methods": hashes[second][1]},
            "contentEqual": hashes[first][0] == hashes[second][0],
            "bytesEqual": file_sha256(first) == file_sha256(second),
        })
    return rows


def run_tests(tree: Path, tests: list[str], work: Path, config: str) -> list[dict]:
    env = stage_env(work, "stage2")
    results = []
    for spec in tests:
        project, _, test_filter = spec.partition("::")
        log = work / ("test-" + Path(project).stem + ".log")
        log.write_text("", encoding="utf-8")
        command = ["dotnet", "test", project, "-c", config, "-nodeReuse:false",
                   "--logger", f"trx;LogFileName={work / (Path(project).stem + '.trx')}"]
        if test_filter:
            command += ["--filter", test_filter]
        code, elapsed = run(command, tree, env, log)
        summary = [line.strip() for line in log.read_text(encoding="utf-8", errors="replace").splitlines()
                   if line.strip().startswith(("Passed!", "Failed!", "Total tests", "Passed:", "Failed:"))]
        results.append({"project": project, "filter": test_filter, "exitCode": code,
                        "seconds": round(elapsed, 1), "summary": summary[-3:]})
    return results


def decide(report: dict) -> tuple[bool, bool]:
    """Equivalent only if every compared assembly's IL+metadata matches and
    at least one assembly was compared; tests pass only if every run exited 0."""
    rows = report["comparison"]
    equivalent = bool(rows) and all(row["contentEqual"] for row in rows)
    tests_passed = all(test["exitCode"] == 0 for test in report["tests"])
    return equivalent, tests_passed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tree", required=True, type=Path)
    parser.add_argument("--bootstrap", required=True, type=Path, help="stage-0 Gsharp.NET.Sdk nupkg")
    parser.add_argument("--stage1", required=True, type=Path, help="stage-1 Gsharp.NET.Sdk nupkg")
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--project", action="append", help="tree-relative project to build (repeatable)")
    parser.add_argument("--assembly", action="append", help="tree-relative output assembly to compare (repeatable)")
    parser.add_argument("--test", action="append", default=[],
                        help="tree-relative test project, optionally '::<filter>', run under stage 2 (repeatable)")
    parser.add_argument("--config", default="Release")
    args = parser.parse_args(argv)

    tree, work = args.tree.resolve(), args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    projects = args.project or DEFAULT_PROJECTS
    assemblies = args.assembly or DEFAULT_ASSEMBLIES
    report: dict = {"tree": str(tree), "projects": projects}
    try:
        report["stage1Build"] = build_stage(tree, "stage1", args.bootstrap.resolve(), projects, assemblies, work, args.config)
        report["stage2Build"] = build_stage(tree, "stage2", args.stage1.resolve(), projects, assemblies, work, args.config)
        report["comparison"] = compare(report["stage1Build"], report["stage2Build"], work)
        report["tests"] = run_tests(tree, args.test, work, args.config)
    except (Stage2Error, packer.SelfHostError) as error:
        report["error"] = str(error)
        (work / "stage2-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"selfhost-stage2: {error}", file=sys.stderr)
        return 2

    equivalent, tests_passed = decide(report)
    report["equivalent"] = equivalent
    report["testsPassed"] = tests_passed
    (work / "stage2-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    for row in report["comparison"]:
        verdict = "EQUAL" if row["contentEqual"] else "DIFFERENT"
        print(f"{verdict:9} {row['assembly']}: stage1 {row['stage1']['content'][:16]} "
              f"stage2 {row['stage2']['content'][:16]} (bytes {'equal' if row['bytesEqual'] else 'differ'})")
    for test in report["tests"]:
        print(f"tests {test['project']} [{test['filter']}]: exit {test['exitCode']} {' | '.join(test['summary'])}")
    print("self-host stage 2: " + ("EQUIVALENT" if equivalent else "NOT EQUIVALENT")
          + ("" if tests_passed else "; TESTS FAILED"))
    return 0 if equivalent and tests_passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
