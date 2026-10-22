# Self-host compiler benchmark: G#-built gsc vs C#-built gsc

Issue [#4631](https://github.com/DavidObando/gsharp/issues/4631) (C6). The owner's budget for the compiler built from G#
source is at most **1.5x** the C#-built compiler's compile time and peak memory; 1:1 is the aspiration.

```sh
python3 build/selfhost-bench.py \
  --rsp <tree>/out/obj/Core/Release/GSharp.Core.rsp --cwd <tree>/src/Core \
  --native <stage-0 package>/tools/compiler/gsc.dll \
  --migrated <stage-1 package>/tools/compiler/gsc.dll \
  --runs 5 --warmup 1 --budget 1.5 --work <dir>
```

- **Same input for both compilers.** Each compiles the same response file, the one an SDK build of the migrated tree's `src/Core` writes (692 `.gs` files, 173 references, the G# internal analyzers, `/optimize+ /deterministic+ /debug:portable`). The packages come from build/selfhost-pack-stage1.py (#4669).
- **Output.** Output options are redirected into the work directory.
- **Interleaving.** Runs alternate which compiler goes first, so load on a shared machine affects both.
- **Measurement.** Each run is measured with GNU time: wall seconds, user+system CPU seconds, maximum RSS.
- **Verdict.** It compares medians. Exit 1 when any migrated/native median ratio exceeds the budget; exit 2 on a failed compile.

`build/test-selfhost-bench.py` is the unit and gate test. It uses stand-in compilers: an equal one passes, while a 3x slower one and a 10x memory-hungry one fail the gate.

## Measured (2026-10-01)

- Tree: nightly 36930275716 at `6c4824cbc`, with polish deltas.
- Native compiler: `Gsharp.NET.Sdk 0.4.1129-g6c4824cbc0` (stage 0, C#-built).
- Migrated compiler: `0.4.1129-stage1` (packed from the migrated tree with stage 0).
- Runs: 1 warmup and 3 measured runs per compiler, on a 20-core Linux host shared with other jobs. The load average was 30.3 / 19.7 / 16.2 at the start and 5.4 / 7.1 / 9.1 at the end.

| Metric (median) | C#-built gsc | G#-built gsc | Ratio |
|---|---|---|---|
| Wall time | 293.6 s (288.6-309.2) | 306.6 s (282.3-323.1) | 1.044 |
| CPU time | 306.0 s | 318.5 s | 1.041 |
| Peak RSS | 887.2 MB | 900.4 MB | 1.015 |

Verdict: **within budget**, close to 1:1. The G#-built `GSharp.Core.dll` is larger on disk than the C#-built one (4.9 MB vs 3.2 MB), but neither compile time nor peak memory follows that difference.

## Before/after benchmark for compiler changes: `build/compiler-bench.py`

Issue [#5127](https://github.com/DavidObando/gsharp/issues/5127) (Q9). A performance change to the compiler needs the same
evidence each time. The script runs a baseline compiler and a candidate compiler interleaved on the same inputs and
checks that their outputs match. It reuses the measurement helpers of `build/selfhost-bench.py`. It is a developer tool,
not a CI gate.

```sh
python3 build/compiler-bench.py \
  --baseline ~/.nuget/packages/gsharp.net.sdk/<pin>/tools/compiler/gsc.dll \
  --candidate out/bin/Release/Compiler/gsc.dll \
  --cell core out/obj/Core/Release/GSharp.Core.rsp src/Core \
  --cell coretests out/obj/Core.Tests/Release/GSharp.Core.Tests.rsp tests/Core.Tests \
  --hello hello.gs --runs 5 --warmup 1
```

- **Cells.** Each `--cell NAME RSP CWD` is a response file and the project directory its relative paths resolve against. `--hello FILE.gs` adds a hello-world cell that reuses the first cell's options with `FILE.gs` as the only source.
- **Response files** are read as `utf-8-sig`, because the SDK writes a BOM.
- **Work root.** Output options are redirected into a staging directory under `~/.cache/q9-bench/run-<time>` (override with `--work`). Every run stages to the same path, so the path embedded in the PDB, and the content hash derived from it, is the same for all runs. A work root under `/tmp` is refused unless `--allow-tmp` is given. Large outputs are deleted after each run; `compiler-bench-report.json` stays, and `--keep` keeps everything.
- **Interleaving.** Runs alternate which compiler goes first.
- **Measurements.** Per cell: wall, CPU and peak RSS as median (min-max), and the `GSHARP_MEASURE_PHASES` phases aggregated by name (count, median wall milliseconds) with the counters. The script sets `GSHARP_MEASURE_PHASES` for each run. Samples are small and the host is shared, so the numbers rank costs; they are not confidence intervals.
- **Parity.** The reference assembly, PDB, XML documentation and the diagnostics stream must be byte-identical. The implementation DLL is compared byte for byte; differences are classified into the groups a deterministic build derives from content: COFF timestamp, PE checksum, MVID (located by `build/selfhost_pe.py`), debug directory and debug payloads. Those groups are reported by name and do not fail the run. Any other differing byte fails. The first two baseline runs are compared as a control, and a control failure means the baseline itself is not deterministic.
- **Exit status.** 0 outputs match, 1 an unexpected output difference, 2 a tool error (a compile failed, GNU time is missing, or the work root is under `/tmp`).

`/sourcelink` is an input file, so the script leaves it alone. The script does not collect `dotnet-counters` or `dotnet-trace` data; run those by hand as in the study's reproduction section.

`build/test-compiler-bench.py` uses stand-in compilers. It checks that identical outputs pass, that a difference in the PDB, reference assembly, XML documentation, diagnostics or an implementation DLL method body fails, that a difference only in the checksum and debug payload passes and is reported, and that a nondeterministic baseline fails through the control.
