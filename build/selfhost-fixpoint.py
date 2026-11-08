#!/usr/bin/env python3
"""Stage-2/stage-3 compiler PE fixpoint check (issue #4925, ADR-0198).

Builds Core and Compiler with the in-tree stage-1 gsc (producing stage 2),
rebuilds them with that stage-2 gsc (producing stage 3), and compares the
stage-2 and stage-3 ``GSharp.Core.dll`` and ``gsc.dll`` PE images using the
fail-closed ``build/selfhost_pe.py`` comparator (byte-identical modulo the
validated ``Module.Mvid`` slot).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import selfhost_pe as pe

REPO = Path(__file__).resolve().parent.parent
ASSEMBLIES = (
    ("Core", "GSharp.Core.dll"),
    ("Compiler", "gsc.dll"),
)


class FixpointError(RuntimeError):
    pass


def _run(cmd: list[str], cwd: Path = REPO) -> None:
    result = subprocess.run(cmd, cwd=cwd)
    if result.returncode != 0:
        raise FixpointError(f"command exited {result.returncode}: {' '.join(cmd)}")


def _clean_compiler_outputs(repo: Path, config: str) -> None:
    for subdir, _ in ASSEMBLIES:
        for base in (repo / "out" / "bin" / config / subdir, repo / "out" / "obj" / subdir / config):
            if base.exists():
                shutil.rmtree(base)


def _build_compiler(repo: Path, config: str, compiler_dll: Path | None = None) -> None:
    if compiler_dll is None:
        cmd = [
            "dotnet", "build", str(repo / "src" / "Compiler" / "Compiler.gsproj"),
            "--configuration", config, "--no-restore", "-graph",
        ]
        _run(cmd, cwd=repo)
        return
    for subdir, _ in ASSEMBLIES:
        proj = repo / "src" / subdir / f"{subdir}.gsproj"
        cmd = [
            "dotnet", "build", str(proj),
            "--configuration", config, "--no-restore", "--no-dependencies",
            f"-p:GsharpCompilerFullPath={compiler_dll}",
            "-p:NoWarn=GS0536",
        ]
        _run(cmd, cwd=repo)


def _snapshot_stage(repo: Path, config: str, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    compiler_dir = repo / "out" / "bin" / config / "Compiler"
    if not (compiler_dir / "gsc.dll").is_file():
        raise FixpointError(f"expected gsc.dll at {compiler_dir / 'gsc.dll'}")
    shutil.copytree(compiler_dir, dest / "Compiler", dirs_exist_ok=True)
    for subdir, dll in ASSEMBLIES:
        src = repo / "out" / "bin" / config / subdir / dll
        if not src.is_file():
            raise FixpointError(f"expected {dll} at {src}")
        shutil.copy2(src, dest / dll)
    return dest / "Compiler" / "gsc.dll"


def compare_stage_directories(stage2_dir: Path, stage3_dir: Path) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    mismatches: list[str] = []
    for _, dll in ASSEMBLIES:
        left_path = stage2_dir / dll
        right_path = stage3_dir / dll
        if not left_path.is_file():
            raise FixpointError(f"missing stage-2 assembly: {left_path}")
        if not right_path.is_file():
            raise FixpointError(f"missing stage-3 assembly: {right_path}")
        left, right, equal = pe.compare(left_path, right_path)
        results.append({
            "assembly": dll,
            "equal": equal,
            "stage2_normalized_sha256": left.normalized_sha256,
            "stage3_normalized_sha256": right.normalized_sha256,
            "stage2_raw_sha256": left.raw_sha256,
            "stage3_raw_sha256": right.raw_sha256,
        })
        if not equal:
            mismatches.append(
                f"{dll}: stage-2 normalized={left.normalized_sha256} (size={left.size}) "
                f"!= stage-3 normalized={right.normalized_sha256} (size={right.size})"
            )
    if mismatches:
        raise FixpointError("stage-2/stage-3 fixpoint mismatch:\n  " + "\n  ".join(mismatches))
    return results


def run_fixpoint(repo: Path = REPO, config: str = "Release", work_dir: Path | None = None) -> list[dict[str, object]]:
    compiler_out = repo / "out" / "bin" / config / "Compiler" / "gsc.dll"
    if not compiler_out.is_file():
        _build_compiler(repo, config)

    work_Parent = work_dir or (Path.home() / ".cache" / "gsharp-fixpoint")
    work_Parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="run-", dir=work_Parent) as tmp:
        scratch = Path(tmp)
        stage1_gsc = _snapshot_stage(repo, config, scratch / "stage1")

        _clean_compiler_outputs(repo, config)
        _build_compiler(repo, config, compiler_dll=stage1_gsc)
        stage2_gsc = _snapshot_stage(repo, config, scratch / "stage2")

        _clean_compiler_outputs(repo, config)
        _build_compiler(repo, config, compiler_dll=stage2_gsc)
        _snapshot_stage(repo, config, scratch / "stage3")

        return compare_stage_directories(scratch / "stage2", scratch / "stage3")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="Release")
    parser.add_argument("--compare-only", nargs=2, metavar=("STAGE2_DIR", "STAGE3_DIR"))
    args = parser.parse_args(argv)
    try:
        if args.compare_only:
            results = compare_stage_directories(Path(args.compare_only[0]), Path(args.compare_only[1]))
        else:
            results = run_fixpoint(REPO, args.config)
    except (FixpointError, pe.PeError) as exc:
        print(f"selfhost-fixpoint: {exc}", file=sys.stderr)
        return 1
    for row in results:
        print(f"{row['assembly']}: OK (normalized_sha256={row['stage2_normalized_sha256']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
