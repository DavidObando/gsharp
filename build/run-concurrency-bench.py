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

Methodology, normative per D11: Release builds on both sides, enough
call-counted warm-up entries to put every G# scenario body in Tier1, and
several process launches here, because in-process repetition alone understates
variance. When Go is requested, launch order rotates so host drift cannot
consistently favor one runtime.

The G# side is measured in two modes, because "how fast is G#" has two honest
answers and reporting one of them alone was how this harness first went wrong
(issues #3901, #3902):

  jit  CoreCLR with tiering and dynamic PGO explicitly enabled and the
       call-counting delay pinned to zero. Without the pin, a
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
way. Both are reported, and a budget may be recorded against either. JSON
retains every launch sample plus the runtime, build, host, power and load
fingerprints needed to explain a shift. Aggregation rejects different
methodology/build keys; baseline gating requires a matching comparison key.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
import random
import re
import shutil
import statistics
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BENCH = REPO / "bench" / "concurrency"
# The trailing `ms <elapsed>` is optional so the runner reads both the old
# and the current Bench.gs output (issue #3902).
ROW = re.compile(
    r"^(?P<name>[A-Za-z0-9_.-]+) ns_per_op (?P<value>[0-9]+(?:\.[0-9]+)?)"
    r"(?: ms (?P<elapsed_ms>[0-9]+(?:\.[0-9]+)?))?$")
GO_ROW = re.compile(r"^\[(?P<name>[^\]]+?)\s*\]\s+[0-9.]+ ms\s+(?P<value>[0-9.]+) ns/op$")
RUNTIME_ROW = re.compile(r"^runtime (?P<version>\S+) cores (?P<cores>[0-9]+)$")
GO_RUNTIME_ROW = re.compile(
    r"^go=(?P<version>.+?) numcpu=(?P<numcpu>[0-9]+) gomaxprocs=(?P<cores>[0-9]+)$"
)

# Pinning the tiering delay is normative, not a tuning knob; see the module
# docstring. Without it the reported number depends on whether a 100 ms timer
# happened to elapse before the process exited.
PINNED_TIER_ENV = {
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
JSON_SCHEMA_VERSION = 2
METHODOLOGY_VERSION = 2
BASELINE_RUNS = 3
GO_WARMUP_ROUNDS = 3


def load_scenarios() -> list[dict]:
    return json.loads((BENCH / "scenarios.json").read_text())["scenarios"]


def command_output(command: list[str]) -> str | None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError:
        return None
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def cpu_model() -> str:
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        for line in cpuinfo.read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()

    if platform.system() == "Darwin":
        model = command_output(["sysctl", "-n", "machdep.cpu.brand_string"])
        if model:
            return model
        model = command_output(["sysctl", "-n", "hw.model"])
        if model:
            return model

    return platform.processor() or "unknown-cpu"


def hardware_class() -> str:
    """A stable host key: OS, architecture, logical CPUs and CPU model."""
    model = re.sub(r"[^A-Za-z0-9]+", "-", cpu_model()).strip("-").lower()
    return f"{platform.system().lower()}-{platform.machine().lower()}-{os.cpu_count()}-{model}"


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


def power_state() -> dict:
    state = {
        "governors": read_distinct("/sys/devices/system/cpu/cpu*/cpufreq/scaling_governor"),
        "scalingDrivers": read_distinct("/sys/devices/system/cpu/cpu*/cpufreq/scaling_driver"),
    }
    if platform.system() == "Darwin":
        output = command_output(["pmset", "-g", "batt"])
        state["powerSource"] = output.splitlines()[0] if output else None
    else:
        online = {}
        for path in Path("/sys/class/power_supply").glob("*/online"):
            try:
                online[path.parent.name] = path.read_text().strip()
            except OSError:
                pass
        state["powerSource"] = online
    return state


def environment_sample() -> dict:
    try:
        load = [round(value, 3) for value in os.getloadavg()]
    except (AttributeError, OSError):
        load = None

    affinity = None
    if hasattr(os, "sched_getaffinity"):
        affinity = sorted(os.sched_getaffinity(0))

    frequencies = []
    for path in Path("/sys/devices/system/cpu").glob("cpu*/cpufreq/scaling_cur_freq"):
        try:
            frequencies.append(int(path.read_text().strip()))
        except (OSError, ValueError):
            pass

    return {
        "timestampUtc": datetime.now(timezone.utc).isoformat(),
        "loadAverage": load,
        "cpuAffinity": affinity,
        "frequencyKHz": {
            "min": min(frequencies),
            "max": max(frequencies),
        } if frequencies else None,
        "power": power_state(),
    }


def clean_runtime_environment(base: dict[str, str], pinned: bool) -> tuple[dict[str, str], dict[str, str]]:
    """Remove ambient JIT overrides, then install the benchmark's intended tier."""
    env = dict(base)
    removed = {}
    for key in list(env):
        if key.upper().startswith(RUNTIME_SETTING_PREFIXES):
            removed[key] = env.pop(key)
    if pinned:
        env.update(PINNED_TIER_ENV)
    return env, removed


def sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def definition_hash() -> str:
    digest = hashlib.sha256()
    for path in (BENCH / "gsharp" / "Bench.gs", BENCH / "go" / "main.go", BENCH / "scenarios.json"):
        digest.update(str(path.relative_to(REPO)).encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def warmup_configuration() -> dict:
    program = (BENCH / "gsharp" / "Bench.gs").read_text()
    rounds = re.search(r"^let warmupRounds = ([0-9]+)$", program, re.MULTILINE)
    ops = re.search(r"^let warmupOps = ([0-9]+)$", program, re.MULTILINE)
    if not rounds or not ops:
        raise SystemExit("Bench.gs must declare numeric warmupRounds and warmupOps")
    return {"rounds": int(rounds.group(1)), "ops": int(ops.group(1))}


def stable_key(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def git_value(*args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO), *args],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def gsc_informational_version(gsc: Path) -> str | None:
    deps = gsc.with_name("gsc.deps.json")
    if not deps.exists():
        return None
    libraries = json.loads(deps.read_text()).get("libraries", {})
    package = next((name for name in libraries if name.startswith("gsc/")), None)
    return package.split("/", 1)[1] if package else None


def incomparability_reasons(
    start_environment: dict,
    end_environment: dict,
    runtime_versions: dict[str, list[str]],
    processor_counts: dict[str, list[int]],
) -> list[str]:
    reasons = []
    if start_environment["power"] != end_environment["power"]:
        reasons.append("power state changed while the benchmark was running")
    if start_environment["cpuAffinity"] != end_environment["cpuAffinity"]:
        reasons.append("CPU affinity changed while the benchmark was running")
    if not any(start_environment["power"].values()):
        reasons.append("the host exposes no observable power-state identity")
    for mode, counts in processor_counts.items():
        versions = runtime_versions.get(mode, [])
        if not versions:
            reasons.append(f"{mode} did not report its runtime version")
        elif len(versions) > 1:
            reasons.append(f"{mode} reported different runtime versions across launches: {versions}")
        if not counts:
            reasons.append(f"{mode} did not report its processor count")
        elif len(counts) > 1:
            reasons.append(f"{mode} reported different processor counts across launches: {counts}")
    return reasons


def make_fingerprint(
    *,
    gsc: Path,
    extensions: Path,
    assembly: Path,
    aot_binary: Path | None,
    go_binary: Path | None,
    launches: int,
    scenario: str | None,
    modes: list[str],
    runtime_versions: dict[str, list[str]],
    processor_counts: dict[str, list[int]],
    runtime_environment: dict[str, str],
    removed_runtime_settings: dict[str, str],
    start_environment: dict,
    end_environment: dict,
) -> dict:
    comparison = {
        "methodologyVersion": METHODOLOGY_VERSION,
        "wholeRuns": 1,
        "intervalMethod": "bootstrap-launch-median",
        "runnerSha256": sha256(Path(__file__)),
        "benchmarkDefinitionSha256": definition_hash(),
        "jitMode": "tiered-pgo-steady-state",
        "jitEnvironment": PINNED_TIER_ENV,
        "warmup": warmup_configuration(),
        "goWarmupRounds": GO_WARMUP_ROUNDS if go_binary else None,
        "launches": launches,
        "scenario": scenario or "all",
        "launchOrder": "rotating-interleaved" if len(modes) > 1 else "single-mode",
        "modes": modes,
        "host": {
            "hardwareClass": hardware_class(),
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "cpuModel": cpu_model(),
            "logicalCpuCount": os.cpu_count(),
            "cpuAffinity": start_environment["cpuAffinity"],
            "reportedProcessorCounts": processor_counts,
        },
        "power": start_environment["power"],
        "toolchains": {
            "dotnetSdk": command_output(["dotnet", "--version"]),
            "dotnetRuntime": runtime_versions.get("gsharp", []),
            "nativeAotRuntime": runtime_versions.get("gsharp_aot", []) if aot_binary else None,
            "go": runtime_versions.get("go", []) if go_binary else None,
        },
        "runtimeEnvironment": {
            key: value
            for key, value in runtime_environment.items()
            if key.upper().startswith(("DOTNET_", "COMPLUS_"))
        },
        "goEnvironment": {
            key: os.environ.get(key)
            for key in (
                "GOMAXPROCS",
                "GODEBUG",
                "GOAMD64",
                "GOARM64",
                "GOFLAGS",
                "GOEXPERIMENT",
                "GOGC",
                "GOMEMLIMIT",
                "CGO_ENABLED",
            )
        } if go_binary else None,
    }
    git_status = git_value("status", "--porcelain")
    build = {
        "gitCommit": git_value("rev-parse", "HEAD"),
        "gitDirty": None if git_status is None else bool(git_status),
        "gscInformationalVersion": gsc_informational_version(gsc),
        "artifacts": {
            "gsc": sha256(gsc),
            "Bench.dll": sha256(assembly),
            "Gsharp.Extensions.dll": sha256(extensions),
            "Gsharp.Runtime.Channels.dll": sha256(assembly.parent / "Gsharp.Runtime.Channels.dll"),
            "NativeAOT": sha256(aot_binary) if aot_binary else None,
            "go": sha256(go_binary) if go_binary else None,
        },
    }
    reasons = incomparability_reasons(
        start_environment,
        end_environment,
        runtime_versions,
        processor_counts,
    )

    fingerprint = {
        "runId": str(uuid.uuid4()),
        "comparison": comparison,
        "build": build,
        "removedRuntimeSettings": removed_runtime_settings,
        "comparable": not reasons,
        "incomparabilityReasons": reasons,
    }
    fingerprint["comparisonKey"] = stable_key(comparison)
    fingerprint["aggregationKey"] = stable_key({"comparison": comparison, "build": build})
    return fingerprint


def aggregate_fingerprint(fingerprints: list[dict]) -> dict | None:
    if not fingerprints:
        return None
    fingerprint = copy.deepcopy(fingerprints[0])
    comparison = fingerprint["comparison"]
    comparison["wholeRuns"] = len(fingerprints)
    comparison["intervalMethod"] = "range-of-run-medians"
    fingerprint.pop("runId", None)
    fingerprint["sourceRunIds"] = [item["runId"] for item in fingerprints]
    fingerprint["comparisonKey"] = stable_key(comparison)
    fingerprint["aggregationKey"] = stable_key({
        "comparison": comparison,
        "build": fingerprint["build"],
    })
    return fingerprint


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


def build_go(out: Path) -> Path | None:
    if shutil.which("go") is None:
        return None

    go_dir = BENCH / "go"
    binary = out / "go-baseline"
    subprocess.run(["go", "build", "-o", str(binary), "."], check=True, cwd=go_dir, stdout=subprocess.DEVNULL)
    return binary


def validate_rows(spec: dict, rows: dict[str, float]) -> None:
    missing = spec["expectedRows"] - rows.keys()
    unexpected = rows.keys() - spec["expectedRows"]
    if missing or (unexpected and not spec.get("allowExtraRows", False)):
        raise SystemExit(
            f"{spec['name']} benchmark emitted the wrong rows; "
            f"missing={sorted(missing)}, unexpected={sorted(unexpected)}"
        )


def run_once(spec: dict) -> tuple[dict[str, float], dict | None]:
    result = subprocess.run(
        spec["command"],
        capture_output=True,
        text=True,
        cwd=spec["cwd"],
        env=spec["env"],
    )
    if result.returncode != 0:
        raise SystemExit(
            f"{spec['name']} benchmark run failed (exit {result.returncode}):\n"
            f"{result.stdout}\n{result.stderr}"
        )

    rows = {}
    runtime = None
    for line in result.stdout.splitlines():
        line = line.strip()
        match = spec["pattern"].match(line)
        if match:
            rows[match["name"]] = float(match["value"])
        header = RUNTIME_ROW.match(line)
        if header:
            runtime = {"version": header["version"], "cores": int(header["cores"])}
        go_header = GO_RUNTIME_ROW.match(line)
        if go_header:
            runtime = {"version": go_header["version"], "cores": int(go_header["cores"])}
    if not rows:
        raise SystemExit(f"{spec['name']} benchmark produced no result rows:\n{result.stdout}")
    validate_rows(spec, rows)
    return rows, runtime


def measure_modes(
    specs: list[dict],
    launches: int,
) -> tuple[dict[str, dict[str, list[float]]], dict[str, list[str]], dict[str, list[int]], list[list[str]]]:
    """Rotate launch order so a drifting host does not consistently favor one runtime."""
    if launches % len(specs) != 0:
        raise SystemExit(
            f"--launches must be divisible by the {len(specs)} measured modes "
            "so each mode occupies every launch position equally"
        )
    samples = {spec["name"]: {} for spec in specs}
    runtime_versions = {spec["name"]: [] for spec in specs}
    processor_counts = {spec["name"]: [] for spec in specs}
    orders = []
    for launch in range(launches):
        ordered = specs[launch % len(specs):] + specs[:launch % len(specs)]
        orders.append([spec["name"] for spec in ordered])
        for spec in ordered:
            rows, runtime = run_once(spec)
            for name, value in rows.items():
                samples[spec["name"]].setdefault(name, []).append(value)
            if runtime:
                if runtime["version"] not in runtime_versions[spec["name"]]:
                    runtime_versions[spec["name"]].append(runtime["version"])
                if runtime["cores"] not in processor_counts[spec["name"]]:
                    processor_counts[spec["name"]].append(runtime["cores"])
    return samples, runtime_versions, processor_counts, orders


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
            "launch_samples_ns": values,
        }
        for name, values in samples.items()
    }


def aggregate(results: list[dict]) -> dict[str, dict]:
    """Combine several whole runs into one result per scenario.

    A single run reports the median of its launches and a bootstrap interval
    over them, which measures variation WITHIN one process-launch sequence. It
    says nothing about how much the machine moved between runs, and on a shared
    CI runner that between-run term is far the larger of the two. Aggregating
    several runs makes the reported interval cover both.
    """
    names: list[str] = []
    for result in results:
        for name in result:
            if name not in names:
                names.append(name)

    combined: dict[str, dict] = {}
    for name in names:
        medians = [r[name]["median_ns"] for r in results if name in r]
        if not medians:
            continue

        combined[name] = {
            "median_ns": round(statistics.median(medians), 2),
            "ci95_ns": [round(min(medians), 2), round(max(medians), 2)] if len(medians) > 1 else None,
            "samples": sum(r[name].get("samples", 0) for r in results if name in r),
            "runs": len(medians),
            "launch_samples_ns": [
                value
                for result in results
                if name in result
                for value in result[name].get("launch_samples_ns", [])
            ],
            "run_medians_ns": medians,
        }

    return combined


def combine_loaded_runs(results: list[dict]) -> dict:
    return results[0] if len(results) == 1 else aggregate(results)


def load_runs(paths: list[str]) -> tuple[list[dict], list[dict], list[dict], str | None, dict]:
    """Read run JSONs written by an earlier --json invocation."""
    gsharp, gsharp_aot, go = [], [], []
    recorded_class = None
    metadata = {
        "effectiveFingerprints": [],
        "sourceFingerprints": [],
        "environments": [],
        "launchOrders": [],
    }
    aggregation_key = None
    seen_paths = set()
    seen_payloads = set()
    seen_run_ids = set()
    for path in paths:
        resolved = Path(path).resolve()
        if resolved in seen_paths:
            raise SystemExit(f"refusing duplicate --from-json path '{path}'")
        seen_paths.add(resolved)
        payload = json.loads(resolved.read_text())
        payload_key = stable_key(payload)
        if payload_key in seen_payloads:
            raise SystemExit(f"refusing duplicate benchmark evidence '{path}'")
        seen_payloads.add(payload_key)
        recorded_class = payload.get("hardwareClass") or recorded_class
        fingerprint = payload.get("fingerprint")
        if (
            len(paths) > 1
            and fingerprint
            and fingerprint.get("comparison", {}).get("wholeRuns", 1) != 1
        ):
            raise SystemExit(f"refusing to re-aggregate already aggregated run '{path}'")
        key = payload.get("aggregationKey")
        if key is None:
            if len(paths) > 1:
                raise SystemExit(
                    f"refusing to aggregate legacy run '{path}': it has no aggregationKey"
                )
            key = f"legacy-single:{payload.get('hardwareClass')}"
        if aggregation_key is None:
            aggregation_key = key
        elif key != aggregation_key:
            raise SystemExit(
                "refusing to aggregate incomparable benchmark runs: "
                f"'{paths[0]}' has key {aggregation_key}, '{path}' has key {key}"
            )
        if len(paths) > 1 and fingerprint and not fingerprint.get("comparable", True):
            raise SystemExit(
                f"refusing to aggregate '{path}': "
                + "; ".join(fingerprint.get("incomparabilityReasons", ["run marked incomparable"]))
            )
        if fingerprint:
            metadata["effectiveFingerprints"].append(fingerprint)
        source_fingerprints = payload.get("sourceFingerprints")
        if source_fingerprints:
            metadata["sourceFingerprints"].extend(source_fingerprints)
        elif fingerprint:
            metadata["sourceFingerprints"].append(fingerprint)
            source_fingerprints = [fingerprint]
        else:
            source_fingerprints = []
        source_run_ids = [item.get("runId") for item in source_fingerprints]
        if len(paths) > 1 and fingerprint and any(run_id is None for run_id in source_run_ids):
            raise SystemExit(f"refusing to aggregate '{path}': source run identity is missing")
        overlap = seen_run_ids.intersection(run_id for run_id in source_run_ids if run_id)
        if overlap:
            raise SystemExit(
                f"refusing duplicate source run evidence in '{path}': {sorted(overlap)}"
            )
        seen_run_ids.update(run_id for run_id in source_run_ids if run_id)

        source_environments = payload.get("sourceEnvironments")
        if source_environments is not None:
            metadata["environments"].extend(source_environments)
        elif payload.get("environment") is not None:
            metadata["environments"].append(payload["environment"])

        source_launch_orders = payload.get("sourceLaunchOrders")
        if source_launch_orders is not None:
            metadata["launchOrders"].extend(source_launch_orders)
        elif payload.get("launchOrder") is not None:
            metadata["launchOrders"].append(payload["launchOrder"])
        if payload.get("gsharp"):
            gsharp.append(payload["gsharp"])
        if payload.get("gsharp_aot"):
            gsharp_aot.append(payload["gsharp_aot"])
        if payload.get("go"):
            go.append(payload["go"])

    metadata["aggregationKey"] = aggregation_key
    return gsharp, gsharp_aot, go, recorded_class, metadata


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
    verdict = "REGRESSED" if (over and disjoint and gated) else "ok" if gated else "report-only"
    print(f"  {label:<20} {result['median_ns']:>9.2f} ns/op   ceiling {ceiling:>9.2f}   {verdict}")
    return verdict == "REGRESSED"


def check(
    baseline: dict,
    measured: dict[str, dict],
    measured_aot: dict[str, dict],
    scenarios: list[dict],
    current_class: str,
    comparison_key: str | None,
) -> int:
    """The within-runtime gate. A scenario fails only when its median is above
    the recorded ceiling AND the confidence intervals do not overlap AND the
    hardware class matches — three conditions, because any one of them alone
    produces false failures often enough to get the gate switched off.

    Each mode carries its own ceiling. A JIT regression and an AOT regression
    mean different things — the first is a deployment regression, the second a
    codegen or runtime one — so neither is allowed to mask the other."""
    failures = 0
    recorded_class = baseline.get("hardwareClass")
    if recorded_class is not None and recorded_class != current_class:
        print(f"note: baseline was recorded on '{recorded_class}', this is '{current_class}'; reporting only.")

    recorded_key = baseline.get("comparisonKey")
    if recorded_key is None:
        print("note: baseline has no comparison fingerprint; reporting only until it is re-recorded.")
    elif comparison_key != recorded_key:
        print(
            "note: baseline comparison fingerprint differs from this run "
            f"({recorded_key[:12]} != {(comparison_key or 'missing')[:12]}); reporting only."
        )

    gated = (
        recorded_class is not None
        and recorded_class == current_class
        and recorded_key is not None
        and comparison_key == recorded_key
    )
    for scenario in scenarios:
        name = scenario["name"]
        entry = baseline["scenarios"].get(name, {})
        if check_one(entry, measured.get(name), f"{name} (jit)", gated):
            failures += 1

        if measured_aot:
            if check_one(entry.get("aot", {}), measured_aot.get(name), f"{name} (aot)", gated):
                failures += 1

    return failures


def record(
    entry: dict,
    result: dict,
    label: str,
    allow_regression: str | None,
    hardware: str,
    comparison_key: str,
) -> str | None:
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
    entry["runs"] = result.get("runs", 1)
    entry.setdefault("history", []).append(
        {
            "median_ns": result["median_ns"],
            "samples": result["samples"],
            "runs": result.get("runs", 1),
            "hardwareClass": hardware,
            "comparisonKey": comparison_key,
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
    fingerprint: dict,
) -> int:
    comparison = fingerprint["comparison"]
    hardware = comparison["host"]["hardwareClass"]
    comparison_key = fingerprint["comparisonKey"]
    for scenario in scenarios:
        name = scenario["name"]
        entry = baseline["scenarios"].setdefault(name, {"history": []})

        result = measured.get(name)
        if result is not None:
            error = record(entry, result, f"{name} (jit)", allow_regression, hardware, comparison_key)
            if error:
                print(error, file=sys.stderr)
                return 1

        aot_result = measured_aot.get(name)
        if aot_result is not None:
            aot_entry = entry.setdefault("aot", {"history": []})
            error = record(aot_entry, aot_result, f"{name} (aot)", allow_regression, hardware, comparison_key)
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

    baseline["schemaVersion"] = max(3, baseline.get("schemaVersion", 0))
    baseline["hardwareClass"] = comparison["host"]["hardwareClass"]
    baseline["comparisonKey"] = fingerprint["comparisonKey"]
    baseline["comparisonFingerprint"] = comparison
    baseline["toolchain"] = comparison["toolchains"]
    baseline["launches"] = comparison["launches"]
    return 0


def complete_baseline_fingerprint(fingerprint: dict) -> bool:
    comparison = fingerprint["comparison"]
    return (
        comparison["scenario"] == "all"
        and comparison["modes"] == ["gsharp", "gsharp_aot", "go"]
        and comparison["wholeRuns"] == BASELINE_RUNS
        and comparison["intervalMethod"] == "range-of-run-medians"
    )


def complete_baseline_results(
    measured: dict[str, dict],
    measured_aot: dict[str, dict],
    go_measured: dict[str, dict],
) -> bool:
    return all(
        scenario["name"] in measured
        and scenario["name"] in measured_aot
        and (scenario.get("go") is None or scenario["go"] in go_measured)
        for scenario in load_scenarios()
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--launches", type=int, default=6, help="process launches per side (default 6)")
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
    parser.add_argument(
        "--from-json",
        metavar="PATH",
        action="append",
        default=[],
        help="aggregate previously written run JSONs instead of measuring; repeatable. "
             "Several whole runs is what a reported number should rest on — a single run's "
             "interval covers only its own launches.")
    args = parser.parse_args()
    if args.launches < 1:
        parser.error("--launches must be at least 1")

    registry = load_scenarios()
    scenarios = registry
    if args.scenario:
        scenarios = [s for s in scenarios if s["name"] == args.scenario]
        if not scenarios:
            print(f"unknown scenario '{args.scenario}'", file=sys.stderr)
            return 2

    out = REPO / "out" / "bench-concurrency"
    out.mkdir(parents=True, exist_ok=True)

    recorded_class: str | None = None
    fingerprint = None
    environment = None
    launch_order = None
    source_fingerprints = []
    if args.from_json:
        gsharp_runs, aot_runs, go_runs, recorded_class, metadata = load_runs(args.from_json)
        measured = combine_loaded_runs(gsharp_runs)
        measured_aot = combine_loaded_runs(aot_runs)
        go_measured = combine_loaded_runs(go_runs)
        source_fingerprints = metadata["sourceFingerprints"]
        fingerprint = (
            aggregate_fingerprint(source_fingerprints)
            if len(args.from_json) > 1
            else metadata["effectiveFingerprints"][0] if metadata["effectiveFingerprints"] else None
        )
        environment = metadata["environments"]
        launch_order = metadata["launchOrders"]
        represented_runs = fingerprint.get("comparison", {}).get("wholeRuns") if fingerprint else None
        provenance = f"{represented_runs or len(gsharp_runs)} run(s) represented"
    else:
        gsc = Path(args.gsc)
        extensions = Path(args.extensions)
        assembly = compile_bench(gsc, extensions, out)
        requested = scenarios[0]["gsharp"] if args.scenario else None
        jit_env, removed_jit = clean_runtime_environment(os.environ, pinned=True)
        if requested:
            jit_env["GSHARP_BENCH_SCENARIO"] = requested
        specs = [
            {
                "name": "gsharp",
                "command": ["dotnet", "exec", str(assembly)],
                "cwd": out,
                "env": jit_env,
                "pattern": ROW,
                "expectedRows": {requested} if requested else {scenario["gsharp"] for scenario in registry},
            }
        ]

        aot_binary = None
        if args.aot:
            aot_binary = publish_aot(assembly, out)
            aot_env, removed_aot = clean_runtime_environment(os.environ, pinned=False)
            if requested:
                aot_env["GSHARP_BENCH_SCENARIO"] = requested
            specs.append(
                {
                    "name": "gsharp_aot",
                    "command": [str(aot_binary)],
                    "cwd": out,
                    "env": aot_env,
                    "pattern": ROW,
                    "expectedRows": {requested} if requested else {scenario["gsharp"] for scenario in registry},
                }
            )
        else:
            removed_aot = {}

        go_row = scenarios[0].get("go") if args.scenario else None
        go_binary = build_go(out) if args.go and (not args.scenario or go_row) else None
        if go_binary:
            go_env = dict(os.environ)
            if go_row:
                go_env["GSHARP_BENCH_SCENARIO"] = go_row
            specs.append(
                {
                    "name": "go",
                    "command": [str(go_binary), f"-warmup={GO_WARMUP_ROUNDS}"],
                    "cwd": BENCH / "go",
                    "env": go_env,
                    "pattern": GO_ROW,
                    "expectedRows": {go_row} if go_row else {
                        "go-buf64",
                        "go-chunk64",
                        "go-chunk1k",
                        "go-compute",
                        "go-pingpong",
                        "go-closed",
                        "go-spawn",
                        "go-select2",
                    },
                    "allowExtraRows": not bool(go_row),
                }
            )

        start_environment = environment_sample()
        raw_samples, runtime_versions, processor_counts, launch_order = measure_modes(specs, args.launches)
        measured = summarize(raw_samples["gsharp"])
        measured_aot = summarize(raw_samples.get("gsharp_aot", {}))
        go_measured = summarize(raw_samples.get("go", {}))
        end_environment = environment_sample()
        environment = {"start": start_environment, "end": end_environment}
        fingerprint = make_fingerprint(
            gsc=gsc,
            extensions=extensions,
            assembly=assembly,
            aot_binary=aot_binary,
            go_binary=go_binary,
            launches=args.launches,
            scenario=args.scenario,
            modes=[spec["name"] for spec in specs],
            runtime_versions=runtime_versions,
            processor_counts=processor_counts,
            runtime_environment=jit_env,
            removed_runtime_settings={**removed_jit, **removed_aot},
            start_environment=start_environment,
            end_environment=end_environment,
        )
        recorded_class = fingerprint["comparison"]["host"]["hardwareClass"]
        provenance = f"launches: {args.launches}"

    comparison_key = fingerprint.get("comparisonKey") if fingerprint else None
    aggregation_key = fingerprint.get("aggregationKey") if fingerprint else None
    current_class = recorded_class or hardware_class()
    print(
        f"hardware class: {current_class}   {provenance}   "
        f"jit=tiered-pgo delay=0   comparison={(comparison_key or 'legacy')[:12]}"
    )
    if fingerprint and not fingerprint.get("comparable", True):
        print("warning: run is not comparable: " + "; ".join(fingerprint["incomparabilityReasons"]))
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
        payload = {
            "schemaVersion": JSON_SCHEMA_VERSION,
            "gsharp": measured,
            "gsharp_aot": measured_aot,
            "go": go_measured,
            "hardwareClass": current_class,
            "fingerprint": fingerprint,
            "comparisonKey": comparison_key,
            "aggregationKey": aggregation_key,
            "environment": environment,
            "launchOrder": launch_order,
        }
        if source_fingerprints:
            payload["sourceFingerprints"] = source_fingerprints
            payload["sourceEnvironments"] = environment
            payload["sourceLaunchOrders"] = launch_order
        Path(args.json).write_text(
            json.dumps(payload, indent=2) + "\n"
        )

    if args.update_baseline:
        if fingerprint is None:
            print("cannot update a baseline from legacy JSON without a comparison fingerprint", file=sys.stderr)
            return 1
        if not fingerprint.get("comparable", True):
            print("cannot update a baseline from a run marked incomparable", file=sys.stderr)
            return 1
        if (
            args.scenario
            or not complete_baseline_fingerprint(fingerprint)
            or not complete_baseline_results(measured, measured_aot, go_measured)
        ):
            print(
                "baseline updates require a full --go --aot run without --scenario "
                "so every scenario and mode shares the recorded comparison key",
                file=sys.stderr,
            )
            return 1
        path = Path(args.update_baseline)
        baseline = json.loads(path.read_text())
        code = update(
            baseline,
            measured,
            measured_aot,
            go_measured,
            scenarios,
            args.allow_regression,
            fingerprint,
        )
        if code:
            return code

        path.write_text(json.dumps(baseline, indent=2) + "\n")
        print(f"updated {path}")

    if args.check_baseline:
        baseline = json.loads(Path(args.check_baseline).read_text())
        print("\nwithin-runtime gate:")
        gate_key = comparison_key if not fingerprint or fingerprint.get("comparable", True) else None
        failures = check(
            baseline,
            measured,
            measured_aot,
            scenarios,
            current_class,
            gate_key,
        )
        if failures:
            print(f"\n{failures} scenario(s) regressed past their recorded ceiling.", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
