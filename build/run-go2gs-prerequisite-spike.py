#!/usr/bin/env python3
"""Build and compare the hand-written Go/G# prerequisite viability programs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPIKE = REPO / "bench" / "go2gs-prerequisites"
PERF = re.compile(
    r"^perf (?P<name>[a-z-]+) (?P<ticks>[0-9]+) (?P<frequency>[0-9]+) "
    r"(?P<operations>[0-9]+) (?P<allocated_bytes>[0-9]+) "
    r"(?P<allocations>-?[0-9]+) (?P<checksum>-?[0-9]+)$"
)
TIER_ENV = {
    "DOTNET_TieredCompilation": "1",
    "DOTNET_TieredPGO": "1",
    "DOTNET_TC_CallCountingDelayMs": "0",
}
RUNTIME_SETTING_PREFIXES = (
    "DOTNET_TIERED",
    "COMPLUS_TIERED",
    "DOTNET_TC_",
    "COMPLUS_TC_",
    "DOTNET_OSR_",
    "COMPLUS_OSR_",
    "DOTNET_JIT",
    "COMPLUS_JIT",
    "DOTNET_READYTORUN",
    "COMPLUS_READYTORUN",
    "DOTNET_ALTJIT",
    "COMPLUS_ALTJIT",
)
GO_BENCHMARK_ENVIRONMENT_KEYS = (
    "GOMAXPROCS",
    "GODEBUG",
    "GOAMD64",
    "GOARM64",
    "GOFLAGS",
    "GOEXPERIMENT",
    "GOGC",
    "GOMEMLIMIT",
    "CGO_ENABLED",
    "GOENV",
    "GOTOOLCHAIN",
)
EXPECTED_ROWS = {
    "slice-view",
    "slice-append",
    "managed-location",
    "managed-create",
    "adapt-reference",
    "nominal-reference",
    "adapt-location",
    "rich-capture",
    "manual-rich-capture",
    "adapt-create",
    "nominal-create",
    "rich-create",
    "manual-rich-create",
}
EXPECTED_SEMANTIC_ROWS = (
    "slice-shared",
    "managed-detach",
    "rich-capture",
    "adapt-copy",
    "adapt-location",
    "adapt-reference",
    "adapt-independent",
    "pointer-capture",
    "factory-locations",
    "slice-selection",
    "zero-trip-effects",
)
STEADY_STATE_ROWS = (
    "slice-view",
    "managed-location",
    "adapt-reference",
    "nominal-reference",
    "adapt-location",
    "rich-capture",
    "manual-rich-capture",
)
UNSUPPORTED_BOUNDARIES = (
    "typed-nil/interface-nil distinction",
    "interface-to-interface dynamic identity",
    "interface equality/hash/type-switch/map-key semantics",
    "value-receiver copy-per-call dispatch",
)


def run(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(
            f"command failed ({result.returncode}): {' '.join(command)}\n"
            f"{result.stdout}\n{result.stderr}"
        )
    return result.stdout


def command_output(command: list[str]) -> str:
    return run(command, cwd=REPO).strip()


def optional_command_output(command: list[str]) -> str | None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError:
        return None
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def cpu_model() -> str:
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        fields = {}
        for line in cpuinfo.read_text().splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                fields.setdefault(key.strip().lower(), value.strip())
        for key in ("model name", "hardware"):
            if fields.get(key):
                return fields[key]

    if platform.system() == "Darwin":
        for key in ("machdep.cpu.brand_string", "hw.model"):
            model = optional_command_output(["sysctl", "-n", key])
            if model:
                return model

    model = (
        os.environ.get("PROCESSOR_IDENTIFIER")
        if platform.system() == "Windows"
        else platform.processor()
    )
    if model and model.lower() not in {"amd64", "arm64", "aarch64", "x64", "x86_64"}:
        return model
    return "unknown-cpu"


def read_distinct(pattern: str) -> list[str]:
    values = set()
    for path in Path("/").glob(pattern.lstrip("/")):
        try:
            value = path.read_text().strip()
        except OSError:
            continue
        if value:
            values.add(value)
    return sorted(values)


def environment_sample() -> dict[str, object]:
    affinity = sorted(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None
    try:
        load_average = [round(value, 3) for value in os.getloadavg()]
    except (AttributeError, OSError):
        load_average = None
    power = {
        "governors": read_distinct("/sys/devices/system/cpu/cpu*/cpufreq/scaling_governor"),
        "scaling_drivers": read_distinct(
            "/sys/devices/system/cpu/cpu*/cpufreq/scaling_driver"
        ),
    }
    if platform.system() == "Darwin":
        output = optional_command_output(["pmset", "-g", "batt"])
        power["power_source"] = output.splitlines()[0] if output else None
    else:
        online = {}
        for path in Path("/sys/class/power_supply").glob("*/online"):
            try:
                online[path.parent.name] = path.read_text().strip()
            except OSError:
                pass
        power["power_source"] = online
    return {
        "recorded_utc": datetime.now(UTC).isoformat(),
        "load_average": load_average,
        "cpu_affinity": affinity,
        "power": power,
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_runtime_environment(
    base: dict[str, str],
) -> tuple[dict[str, str], dict[str, str]]:
    environment = dict(base)
    removed = {}
    for key in list(environment):
        if key.upper().startswith(RUNTIME_SETTING_PREFIXES):
            removed[key] = environment.pop(key)
    environment.update(TIER_ENV)
    return environment, removed


def repository_changes() -> list[str]:
    status = command_output(["git", "status", "--porcelain", "--untracked-files=all"])
    return [
        line
        for line in status.splitlines()
        if not line[3:].startswith("out/")
    ]


def validate_launch_count(launches: int, no_aot: bool) -> None:
    minimum = 3 if no_aot else 5
    if launches < minimum:
        mode = "exploratory --no-aot" if no_aot else "milestone"
        raise ValueError(f"{mode} evidence requires at least {minimum} launches")


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


def semantic_lines(output: str, runtime: str) -> list[str]:
    lines = [line for line in output.splitlines() if line.startswith("semantic ")]
    names = [line.split(maxsplit=2)[1] for line in lines]
    if tuple(names) != EXPECTED_SEMANTIC_ROWS:
        raise SystemExit(
            f"{runtime} semantic rows must be non-empty and exactly "
            f"{list(EXPECTED_SEMANTIC_ROWS)}, got {names}\n{output}"
        )
    return lines


def validate_semantics(outputs: dict[str, str]) -> list[str]:
    parsed = {
        runtime: semantic_lines(output, runtime)
        for runtime, output in outputs.items()
    }
    expected = parsed["go"]
    for runtime in ("gsharp-jit", "gsharp-aot"):
        if runtime not in parsed:
            continue
        if parsed[runtime] != expected:
            raise SystemExit(
                f"semantic parity failed for {runtime} versus go\n"
                f"{runtime}:\n{chr(10).join(parsed[runtime])}\n"
                f"go:\n{chr(10).join(expected)}"
            )
    return expected


def runtime_line(output: str, runtime: str) -> str:
    lines = [line.removeprefix("runtime ") for line in output.splitlines() if line.startswith("runtime ")]
    if len(lines) != 1 or not lines[0]:
        raise SystemExit(f"{runtime} must report exactly one non-empty runtime line\n{output}")
    return lines[0]


def parse_perf(output: str) -> dict[str, dict[str, float | int]]:
    rows: dict[str, dict[str, float | int]] = {}
    for line in output.splitlines():
        match = PERF.match(line)
        if not match:
            if line.startswith("perf "):
                raise SystemExit(f"malformed perf row: {line}\n{output}")
            continue
        name = match["name"]
        if name in rows:
            raise SystemExit(f"duplicate perf row: {name}\n{output}")
        ticks = int(match["ticks"])
        frequency = int(match["frequency"])
        operations = int(match["operations"])
        allocated_bytes = int(match["allocated_bytes"])
        if frequency <= 0 or operations <= 0:
            raise SystemExit(f"invalid raw timing/count fields: {line}")
        rows[name] = {
            "elapsed_ticks": ticks,
            "timer_frequency": frequency,
            "operations": operations,
            "allocated_bytes": allocated_bytes,
            "allocation_count": int(match["allocations"]),
            "ns_per_op": ticks * 1_000_000_000 / frequency / operations,
            "bytes_per_op": allocated_bytes / operations,
            "checksum": int(match["checksum"]),
        }
    if rows.keys() != EXPECTED_ROWS:
        raise SystemExit(f"expected {sorted(EXPECTED_ROWS)}, got {sorted(rows)}\n{output}")
    return rows


def validate_cross_runtime_checksums(
    samples: dict[str, list[dict[str, dict[str, float | int]]]],
) -> None:
    for name in EXPECTED_ROWS:
        by_runtime = {
            runtime: {int(sample[name]["checksum"]) for sample in runtime_samples}
            for runtime, runtime_samples in samples.items()
        }
        unstable = {
            runtime: sorted(checksums)
            for runtime, checksums in by_runtime.items()
            if len(checksums) != 1
        }
        if unstable:
            raise SystemExit(f"{name} checksum changed across launches: {unstable}")
        checksums = {next(iter(values)) for values in by_runtime.values()}
        if len(checksums) != 1:
            raise SystemExit(
                f"{name} checksum differs across runtimes: "
                + ", ".join(
                    f"{runtime}={next(iter(values))}"
                    for runtime, values in by_runtime.items()
                )
            )


def summarize(samples: list[dict[str, dict[str, float | int]]]) -> dict[str, dict[str, float | int]]:
    result = {}
    for name in samples[0]:
        checksums = {int(sample[name]["checksum"]) for sample in samples}
        allocation_counts = [
            int(sample[name]["allocation_count"])
            for sample in samples
            if int(sample[name]["allocation_count"]) >= 0
        ]
        result[name] = {
            "median_ns_per_op": statistics.median(float(sample[name]["ns_per_op"]) for sample in samples),
            "min_ns_per_op": min(float(sample[name]["ns_per_op"]) for sample in samples),
            "max_ns_per_op": max(float(sample[name]["ns_per_op"]) for sample in samples),
            "median_bytes_per_op": statistics.median(
                float(sample[name]["bytes_per_op"]) for sample in samples
            ),
            "median_allocated_bytes": statistics.median(
                int(sample[name]["allocated_bytes"]) for sample in samples
            ),
            "median_allocation_count": (
                statistics.median(allocation_counts) if allocation_counts else None
            ),
            "operations_per_launch": sorted(
                {int(sample[name]["operations"]) for sample in samples}
            ),
            "checksum": checksums.pop(),
        }
    return result


def performance_gate_status(
    samples: dict[str, list[dict[str, dict[str, float | int]]]],
) -> dict[str, object]:
    runtime_status = {}
    for runtime in ("gsharp-jit", "gsharp-aot"):
        if runtime not in samples:
            runtime_status[runtime] = {"available": False, "passed": False}
            continue
        runtime_samples = samples[runtime]
        call_ratios = [
            float(sample["adapt-reference"]["ns_per_op"])
            / float(sample["nominal-reference"]["ns_per_op"])
            for sample in runtime_samples
        ]
        construction_ratios = [
            float(sample["adapt-create"]["ns_per_op"])
            / float(sample["nominal-create"]["ns_per_op"])
            for sample in runtime_samples
        ]
        checks = {
            "steady_state_allocated_bytes_zero": all(
                int(sample[name]["allocated_bytes"]) == 0
                for sample in runtime_samples
                for name in STEADY_STATE_ROWS
            ),
            "adapter_call_time_at_most_1_10x_named_control": (
                statistics.median(call_ratios) <= 1.10
            ),
            "adapter_construction_time_at_most_1_10x_named_control": (
                statistics.median(construction_ratios) <= 1.10
            ),
            "adapter_construction_allocation_matches_named_control_each_launch": all(
                int(sample["adapt-create"]["allocated_bytes"])
                == int(sample["nominal-create"]["allocated_bytes"])
                for sample in runtime_samples
            ),
        }
        runtime_status[runtime] = {
            "available": True,
            "passed": all(checks.values()),
            "checks": checks,
            "median_paired_call_ratio": statistics.median(call_ratios),
            "median_paired_construction_ratio": statistics.median(construction_ratios),
            "paired_call_ratios": call_ratios,
            "paired_construction_ratios": construction_ratios,
        }
    native_controls_passed = all(
        bool(status["passed"]) for status in runtime_status.values()
    )
    return {
        "native_control_gate_passed": native_controls_passed,
        "runtimes": runtime_status,
        "prerequisite_performance_ready": False,
        "open_allocation_gates": ["#4511", "#4512"],
        "note": (
            "Native controls are necessary but not sufficient; maintainers must approve "
            "the #4511/#4512 allocation budgets before performance readiness."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--launches", type=int, default=5)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--no-aot", action="store_true")
    args = parser.parse_args()
    try:
        validate_launch_count(args.launches, args.no_aot)
    except ValueError as error:
        parser.error(str(error))
    if args.no_aot:
        print(
            "warning: --no-aot is exploratory and cannot produce milestone evidence",
            file=sys.stderr,
        )

    out = REPO / "out" / "go2gs-prerequisite-spike"
    out.mkdir(parents=True, exist_ok=True)
    commands = build(out, not args.no_aot)
    environment, removed_runtime_settings = clean_runtime_environment(os.environ)
    model = cpu_model()
    start_environment = environment_sample()

    semantic_outputs = {
        runtime: run(command, cwd=out, env=environment)
        for runtime, command in commands.items()
    }
    semantics = validate_semantics(semantic_outputs)
    reported_runtimes = {
        runtime: runtime_line(output, runtime)
        for runtime, output in semantic_outputs.items()
    }

    environment["GO2GS_SPIKE_BENCH"] = "1"
    samples: dict[str, list[dict[str, dict[str, float | int]]]] = {
        runtime: [] for runtime in commands
    }
    order = list(commands)
    launch_orders = []
    for launch in range(args.launches):
        rotated = order[launch % len(order) :] + order[: launch % len(order)]
        launch_orders.append(rotated)
        for runtime in rotated:
            samples[runtime].append(parse_perf(run(commands[runtime], cwd=out, env=environment)))

    validate_cross_runtime_checksums(samples)
    end_environment = environment_sample()
    provenance_issues = []
    if model == "unknown-cpu":
        provenance_issues.append("the host exposes no identifiable CPU model")
    if not any(start_environment["power"].values()):
        provenance_issues.append("the host exposes no observable power-state identity")
    if start_environment["power"] != end_environment["power"]:
        provenance_issues.append("power state changed while the benchmark was running")
    if start_environment["cpu_affinity"] != end_environment["cpu_affinity"]:
        provenance_issues.append("CPU affinity changed while the benchmark was running")
    summary = {runtime: summarize(runtime_samples) for runtime, runtime_samples in samples.items()}
    performance_gates = performance_gate_status(samples)
    for runtime in (name for name in summary if name.startswith("gsharp-")):
        runtime_gate = performance_gates["runtimes"][runtime]
        for name in summary[runtime]:
            go_ns = float(summary["go"][name]["median_ns_per_op"])
            summary[runtime][name]["ratio_vs_go"] = (
                float(summary[runtime][name]["median_ns_per_op"]) / go_ns if go_ns else None
            )
        summary[runtime]["adapt-reference"]["ratio_vs_nominal"] = (
            runtime_gate["median_paired_call_ratio"]
        )
        summary[runtime]["adapt-create"]["ratio_vs_nominal"] = (
            runtime_gate["median_paired_construction_ratio"]
        )
        summary[runtime]["rich-capture"]["ratio_vs_manual"] = (
            float(summary[runtime]["rich-capture"]["median_ns_per_op"])
            / float(summary[runtime]["manual-rich-capture"]["median_ns_per_op"])
        )
        summary[runtime]["rich-create"]["ratio_vs_manual"] = (
            float(summary[runtime]["rich-create"]["median_ns_per_op"])
            / float(summary[runtime]["manual-rich-create"]["median_ns_per_op"])
        )
    artifacts = {
        "gsc": REPO / "out" / "bin" / "Release" / "Compiler" / "gsc",
        "gsc_dll": REPO / "out" / "bin" / "Release" / "Compiler" / "gsc.dll",
        "gsharp_core": REPO / "out" / "bin" / "Release" / "Compiler" / "GSharp.Core.dll",
        "gsharp_jit": out / "gsharp" / "Go2GsPrerequisites.dll",
        "gsharp_jit_runtimeconfig": out / "gsharp" / "Go2GsPrerequisites.runtimeconfig.json",
        "gsharp_runtime_values": out / "gsharp" / "Gsharp.Runtime.Values.dll",
        "go": Path(commands["go"][0]),
    }
    if "gsharp-aot" in commands:
        artifacts["gsharp_aot"] = Path(commands["gsharp-aot"][0])
    source_files = (
        SPIKE / "gsharp" / "Program.gs",
        SPIKE / "go" / "main.go",
        SPIKE / "go" / "go.mod",
        SPIKE / "aot" / "SpikeAot.csproj",
        SPIKE / "aot" / "Shim.cs",
        Path(__file__).resolve(),
    )
    changes = repository_changes()
    milestone_eligible = not args.no_aot and not changes and not provenance_issues
    result = {
        "evidence": {
            "milestone_eligible": milestone_eligible,
            "classification": "milestone" if milestone_eligible else "exploratory",
            "reason": (
                None if milestone_eligible else (
                    "--no-aot omits required NativeAOT semantic and performance evidence"
                    if args.no_aot
                    else (
                        "repository has uncommitted source changes"
                        if changes
                        else "; ".join(provenance_issues)
                    )
                )
            ),
            "unsupported_boundaries": UNSUPPORTED_BOUNDARIES,
        },
        "semantic_lines": semantics,
        "launches": args.launches,
        "launch_orders": launch_orders,
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "cpu_model": model,
            "cpu_count": os.cpu_count(),
            "start_environment": start_environment,
            "end_environment": end_environment,
        },
        "provenance": {
            "recorded_utc": datetime.now(UTC).isoformat(),
            "repository_commit": command_output(["git", "rev-parse", "HEAD"]),
            "repository_dirty": bool(changes),
            "repository_changes": changes,
            "dotnet_sdk": command_output(["dotnet", "--version"]),
            "dotnet_info": command_output(["dotnet", "--info"]),
            "dotnet_runtimes": command_output(["dotnet", "--list-runtimes"]).splitlines(),
            "go_version": command_output(["go", "version"]),
            "go_environment": command_output(["go", "env", "GOVERSION", "GOOS", "GOARCH"]).splitlines(),
            "reported_runtimes": reported_runtimes,
            "aot_rid": aot_rid() if not args.no_aot else None,
            "tier_environment": TIER_ENV,
            "runtime_environment": {
                key: value
                for key, value in environment.items()
                if key.upper().startswith(("DOTNET_", "COMPLUS_"))
            },
            "go_benchmark_environment": json.loads(
                command_output(
                    ["go", "env", "-json", *GO_BENCHMARK_ENVIRONMENT_KEYS]
                )
            ),
            "removed_runtime_settings": removed_runtime_settings,
            "jit_mode": "pinned-tiered-pgo-steady-state",
            "commands": commands,
            "artifact_sha256": {
                name: sha256(path) for name, path in artifacts.items()
            },
            "source_sha256": {
                str(path.relative_to(REPO)): sha256(path) for path in source_files
            },
        },
        "raw_samples": samples,
        "results": summary,
        "performance_gates": performance_gates,
    }
    text = json.dumps(result, indent=2, sort_keys=True)
    print(text)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
