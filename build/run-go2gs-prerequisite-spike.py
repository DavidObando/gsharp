#!/usr/bin/env python3
"""Build and compare the hand-written Go/G# prerequisite viability programs."""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPIKE = REPO / "bench" / "go2gs-prerequisites"
PERF = re.compile(
    r"^perf (?P<name>[a-z-]+) (?P<ns>[0-9.]+) (?P<bytes>[0-9.]+) (?P<checksum>-?[0-9]+)$"
)
TIER_ENV = {
    "DOTNET_TieredCompilation": "1",
    "DOTNET_TieredPGO": "1",
    "DOTNET_TC_CallCountingDelayMs": "0",
}
EXPECTED_ROWS = {
    "slice-view",
    "slice-append",
    "managed-location",
    "managed-create",
    "managed-retained",
    "managed-first-identity",
    "managed-warmed-identity",
    "managed-readonly-create",
    "adapt-reference",
    "nominal-reference",
    "adapt-location",
    "rich-capture",
    "manual-rich-capture",
    "adapt-create",
    "nominal-create",
    "rich-create",
    "manual-rich-create",
    "rich-create-retained",
    "manual-rich-create-retained",
    "rich-create-fresh-root",
    "manual-rich-create-fresh-root",
    "rich-create-multi",
    "manual-rich-create-multi",
}


def run(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(
            f"command failed ({result.returncode}): {' '.join(command)}\n"
            f"{result.stdout}\n{result.stderr}"
        )
    return result.stdout


def aot_rid() -> str:
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    system = {"Darwin": "osx"}.get(platform.system(), platform.system().lower())
    return f"{system}-{arch}"


def native_aot_environment() -> dict[str, str]:
    environment = os.environ.copy()
    if platform.system() != "Darwin" or shutil.which("brew") is None:
        return environment

    prefixes = []
    for formula in ("openssl@3", "brotli"):
        result = subprocess.run(
            ["brew", "--prefix", formula], capture_output=True, text=True, check=False
        )
        if result.returncode == 0:
            prefixes.append(Path(result.stdout.strip()))
    libraries = [str(prefix / "lib") for prefix in prefixes if (prefix / "lib").is_dir()]
    includes = [str(prefix / "include") for prefix in prefixes if (prefix / "include").is_dir()]
    if libraries:
        environment["LIBRARY_PATH"] = os.pathsep.join(
            libraries + ([environment["LIBRARY_PATH"]] if environment.get("LIBRARY_PATH") else [])
        )
    if includes:
        environment["CPATH"] = os.pathsep.join(
            includes + ([environment["CPATH"]] if environment.get("CPATH") else [])
        )
    return environment


def build(out: Path, include_aot: bool) -> dict[str, list[str]]:
    run(
        ["dotnet", "build", "src/Compiler/Compiler.csproj", "-c", "Release", "--nologo", "-v:q"],
        cwd=REPO,
    )
    gsc = REPO / "out" / "bin" / "Release" / "Compiler" / "gsc"
    gsharp = out / "gsharp"
    gsharp.mkdir(parents=True, exist_ok=True)
    assembly = gsharp / "Go2GsPrerequisites.dll"
    run(
        [
            str(gsc),
            str(SPIKE / "gsharp" / "Program.gs"),
            f"/out:{assembly}",
            "/target:exe",
            "/targetframework:net10.0",
        ],
        cwd=gsharp,
    )

    if shutil.which("go") is None:
        raise SystemExit("Go is required for the paired prerequisite spike")
    go_binary = out / "go-prerequisites"
    run(["go", "build", "-o", str(go_binary), "."], cwd=SPIKE / "go")
    commands = {"gsharp-jit": ["dotnet", str(assembly)], "go": [str(go_binary)]}
    if include_aot:
        publish = out / "aot"
        run(
            [
                "dotnet",
                "publish",
                str(SPIKE / "aot" / "SpikeAot.csproj"),
                "-c",
                "Release",
                "-r",
                aot_rid(),
                "-o",
                str(publish),
                f"-p:SpikeAssembly={assembly}",
                f"-p:GsharpRuntimeDir={gsharp}",
            ],
            cwd=REPO,
            env=native_aot_environment(),
        )
        commands["gsharp-aot"] = [str(publish / "Go2GsPrerequisites")]
    return commands


def semantic_lines(output: str) -> list[str]:
    return [line for line in output.splitlines() if line.startswith("semantic ")]


def parse_perf(output: str) -> dict[str, dict[str, float | int]]:
    rows: dict[str, dict[str, float | int]] = {}
    for line in output.splitlines():
        match = PERF.match(line)
        if match:
            rows[match["name"]] = {
                "ns_per_op": float(match["ns"]),
                "bytes_per_op": float(match["bytes"]),
                "checksum": int(match["checksum"]),
            }
    if rows.keys() != EXPECTED_ROWS:
        raise SystemExit(f"expected {sorted(EXPECTED_ROWS)}, got {sorted(rows)}\n{output}")
    return rows


def summarize(samples: list[dict[str, dict[str, float | int]]]) -> dict[str, dict[str, float | int]]:
    result = {}
    for name in samples[0]:
        checksums = {int(sample[name]["checksum"]) for sample in samples}
        if len(checksums) != 1:
            raise SystemExit(f"{name} checksum changed across launches: {sorted(checksums)}")
        result[name] = {
            "median_ns_per_op": statistics.median(float(sample[name]["ns_per_op"]) for sample in samples),
            "min_ns_per_op": min(float(sample[name]["ns_per_op"]) for sample in samples),
            "max_ns_per_op": max(float(sample[name]["ns_per_op"]) for sample in samples),
            "median_bytes_per_op": statistics.median(
                float(sample[name]["bytes_per_op"]) for sample in samples
            ),
            "checksum": checksums.pop(),
        }
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--launches", type=int, default=5)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--no-aot", action="store_true")
    args = parser.parse_args()
    if args.launches < 3:
        parser.error("--launches must be at least 3")

    out = REPO / "out" / "go2gs-prerequisite-spike"
    out.mkdir(parents=True, exist_ok=True)
    commands = build(out, not args.no_aot)

    gsharp_semantics = semantic_lines(run(commands["gsharp-jit"], cwd=out))
    go_semantics = semantic_lines(run(commands["go"], cwd=out))
    if gsharp_semantics != go_semantics:
        raise SystemExit(
            "semantic parity failed\n"
            f"G#:\n{chr(10).join(gsharp_semantics)}\n"
            f"Go:\n{chr(10).join(go_semantics)}"
        )

    environment = os.environ.copy()
    environment.update(TIER_ENV)
    environment["GO2GS_SPIKE_BENCH"] = "1"
    samples: dict[str, list[dict[str, dict[str, float | int]]]] = {
        runtime: [] for runtime in commands
    }
    order = list(commands)
    for launch in range(args.launches):
        rotated = order[launch % len(order) :] + order[: launch % len(order)]
        for runtime in rotated:
            samples[runtime].append(parse_perf(run(commands[runtime], cwd=out, env=environment)))

    summary = {runtime: summarize(runtime_samples) for runtime, runtime_samples in samples.items()}
    for runtime in (name for name in summary if name.startswith("gsharp-")):
        for name in summary[runtime]:
            go_ns = float(summary["go"][name]["median_ns_per_op"])
            summary[runtime][name]["ratio_vs_go"] = (
                float(summary[runtime][name]["median_ns_per_op"]) / go_ns if go_ns else None
            )
        summary[runtime]["adapt-reference"]["ratio_vs_nominal"] = (
            float(summary[runtime]["adapt-reference"]["median_ns_per_op"])
            / float(summary[runtime]["nominal-reference"]["median_ns_per_op"])
        )
        summary[runtime]["adapt-create"]["ratio_vs_nominal"] = (
            float(summary[runtime]["adapt-create"]["median_ns_per_op"])
            / float(summary[runtime]["nominal-create"]["median_ns_per_op"])
        )
        summary[runtime]["rich-capture"]["ratio_vs_manual"] = (
            float(summary[runtime]["rich-capture"]["median_ns_per_op"])
            / float(summary[runtime]["manual-rich-capture"]["median_ns_per_op"])
        )
        summary[runtime]["rich-create"]["ratio_vs_manual"] = (
            float(summary[runtime]["rich-create"]["median_ns_per_op"])
            / float(summary[runtime]["manual-rich-create"]["median_ns_per_op"])
        )
        for suffix in ("retained", "fresh-root", "multi"):
            summary[runtime][f"rich-create-{suffix}"]["ratio_vs_manual"] = (
                float(summary[runtime][f"rich-create-{suffix}"]["median_ns_per_op"])
                / float(summary[runtime][f"manual-rich-create-{suffix}"]["median_ns_per_op"])
            )

    result = {
        "semantic_lines": gsharp_semantics,
        "launches": args.launches,
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "cpu_count": os.cpu_count(),
            "dotnet": run(["dotnet", "--version"], cwd=REPO).strip(),
            "go": run(["go", "version"], cwd=REPO).strip(),
        },
        "results": summary,
    }
    text = json.dumps(result, indent=2, sort_keys=True)
    print(text)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
