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
- **Output.** Slash-form output switches are matched by exact name and redirected into each run directory, accepting `:` or `=` values and either response-file quoting form. Empty `/log`, `/log:` and `/log=` (including quoted-empty values and case variants) use a run-local `gsharp-compiler-debug.log` rather than the compiler's shared default log. Other empty output switches and unrelated names such as `/logger` are left alone.
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
