#!/usr/bin/env python3

import argparse
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMPILER = ROOT / "out/bin/Release/Compiler/gsc.dll"
CORPUS = [
    ROOT / "samples/Arithmetic.gs",
    ROOT / "samples/Class.gs",
    ROOT / "samples/PatternSwitch.gs",
    ROOT / "samples/AsyncTask.gs",
]
RUNTIME_ITERATIONS = 25_000_000


def run(command: list[str], cwd: Path = ROOT) -> str:
    environment = os.environ.copy()
    environment.update(
        {
            "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
            "DOTNET_NOLOGO": "1",
            "MSBUILDDISABLENODEREUSE": "1",
        }
    )
    result = subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(command)}\n"
            f"{result.stdout}\n{result.stderr}"
        )

    return result.stdout


def measure(command: list[str], repetitions: int, cwd: Path = ROOT) -> float:
    run(command, cwd)
    samples = []
    for _ in range(repetitions):
        started = time.perf_counter()
        run(command, cwd)
        samples.append((time.perf_counter() - started) * 1000)
    return round(statistics.median(samples), 2)


def compile_gsharp(source: Path, output: Path) -> None:
    run(
        [
            "dotnet",
            str(COMPILER),
            f"/out:{output}",
            "/target:exe",
            "/targetframework:net10.0",
            "/optimize+",
            str(source),
        ]
    )


def benchmark(work_directory: Path) -> dict:
    if not COMPILER.exists():
        raise SystemExit(
            f"Missing {COMPILER}. Build first with "
            "`dotnet build src/Compiler/Compiler.csproj -c Release -graph`."
        )

    if work_directory.exists():
        shutil.rmtree(work_directory)
    work_directory.mkdir(parents=True)

    # Stop the generated C# baseline project from inheriting repository-wide
    # package/versioning props; it has no dependencies beyond the SDK.
    (work_directory / "Directory.Build.props").write_text("<Project />\n")
    (work_directory / "Directory.Build.targets").write_text("<Project />\n")

    startup_ms = measure(["dotnet", str(COMPILER), "/help"], repetitions=7)

    corpus_output = work_directory / "corpus"
    corpus_output.mkdir()

    def compile_corpus() -> None:
        for source in CORPUS:
            compile_gsharp(source, corpus_output / f"{source.stem}.dll")

    compile_corpus()
    compile_samples = []
    for _ in range(5):
        started = time.perf_counter()
        compile_corpus()
        compile_samples.append((time.perf_counter() - started) * 1000)
    corpus_compile_ms = round(statistics.median(compile_samples), 2)

    gsharp_source = work_directory / "RuntimeWorkload.gs"
    gsharp_source.write_text(
        f"""package QualityDashboard.Runtime
import System

var iterations = {RUNTIME_ITERATIONS}
var sum = 0
var i = 0
while i < iterations {{
    sum = sum + (i % 97)
    i++
}}
Console.WriteLine(sum)
"""
    )
    gsharp_output = work_directory / "GSharpRuntime.dll"
    compile_gsharp(gsharp_source, gsharp_output)

    csharp_directory = work_directory / "csharp"
    csharp_directory.mkdir()
    (csharp_directory / "CSharpRuntime.csproj").write_text(
        """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <Optimize>true</Optimize>
  </PropertyGroup>
</Project>
"""
    )
    (csharp_directory / "Program.cs").write_text(
        f"""var iterations = {RUNTIME_ITERATIONS};
var sum = 0;
for (var i = 0; i < iterations; i++)
{{
    sum += i % 97;
}}

Console.WriteLine(sum);
"""
    )
    run(["dotnet", "build", "-c", "Release", "--nologo", "--verbosity", "quiet"], csharp_directory)
    csharp_output = csharp_directory / "bin/Release/net10.0/CSharpRuntime.dll"

    gsharp_command = ["dotnet", str(gsharp_output)]
    csharp_command = ["dotnet", str(csharp_output)]
    gsharp_checksum = run(gsharp_command, work_directory).strip()
    csharp_checksum = run(csharp_command, work_directory).strip()
    if gsharp_checksum != csharp_checksum:
        raise RuntimeError(
            f"Runtime benchmark outputs differ: G#={gsharp_checksum}, C#={csharp_checksum}"
        )

    gsharp_runtime_ms = measure(gsharp_command, repetitions=7, cwd=work_directory)
    csharp_runtime_ms = measure(csharp_command, repetitions=7, cwd=work_directory)

    return {
        "startupRounds": 7,
        "compileRounds": 5,
        "runtimeRounds": 7,
        "compilerStartupMedianMs": startup_ms,
        "referenceCorpusCompileMedianMs": corpus_compile_ms,
        "referenceCorpusPrograms": [path.name for path in CORPUS],
        "runtimeIterations": RUNTIME_ITERATIONS,
        "gsharpRuntimeMedianMs": gsharp_runtime_ms,
        "csharpRuntimeMedianMs": csharp_runtime_ms,
        "runtimeRatio": round(gsharp_runtime_ms / csharp_runtime_ms, 3),
        "checksum": gsharp_checksum,
    }


def count_ilverify_suppressions() -> int:
    baseline = ROOT / "build/ilverify-known-failures.txt"
    return sum(
        1
        for line in baseline.read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )


def randomized_case_count() -> int:
    source = (
        ROOT
        / "test/Compiler.Tests/LanguageConformance/RandomizedDriverConformanceTests.cs"
    ).read_text()
    match = re.search(r"\bCaseCount\s*=\s*(\d+)", source)
    if not match:
        raise RuntimeError("Could not find RandomizedDriverConformanceTests.CaseCount.")
    return int(match.group(1))


def conformance_metrics() -> dict:
    single_file_goldens = sorted((ROOT / "samples").glob("*.golden"))
    multi_file_goldens = []
    for directory in (ROOT / "samples").iterdir():
        if directory.is_dir() and (directory / f"{directory.name}.golden").exists():
            multi_file_goldens.append(directory / f"{directory.name}.golden")

    randomized_programs = randomized_case_count()
    cross_driver_programs = len(single_file_goldens) + randomized_programs
    drivers = ["emitted executable", "gsc emit-to-memory", "gsi script"]
    return {
        "drivers": drivers,
        "goldenPrograms": len(single_file_goldens),
        "multiFileGoldenPrograms": len(multi_file_goldens),
        "randomizedPrograms": randomized_programs,
        "crossDriverPrograms": cross_driver_programs,
        "crossDriverExecutions": cross_driver_programs * len(drivers),
        "ilVerifyKnownSuppressions": count_ilverify_suppressions(),
    }


def git(*arguments: str) -> str:
    return run(["git", *arguments]).strip()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate conformance and benchmark data for the public quality dashboard."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "website/static/data/quality-dashboard.json",
    )
    parser.add_argument(
        "--work-directory",
        type=Path,
        default=ROOT / "artifacts/quality-dashboard",
    )
    args = parser.parse_args()

    data = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "commit": git("rev-parse", "HEAD"),
        "commitDate": git("show", "-s", "--format=%cI", "HEAD"),
        "workingTreeDirty": bool(git("status", "--porcelain")),
        "environment": {
            "os": platform.system(),
            "architecture": platform.machine(),
            "dotnetSdk": run(["dotnet", "--version"]).strip(),
        },
        "conformance": conformance_metrics(),
        "benchmarks": benchmark(args.work_directory.resolve()),
    }

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    print(
        f"Wrote {output.relative_to(ROOT)}: "
        f"{data['conformance']['crossDriverPrograms']} programs across "
        f"{len(data['conformance']['drivers'])} drivers; "
        f"corpus compile median {data['benchmarks']['referenceCorpusCompileMedianMs']} ms."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
