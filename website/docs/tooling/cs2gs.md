---
title: "C# to G# migration (cs2gs)"
sidebar_position: 3
draft: false
---

# C# to G# migration (`cs2gs`)

`cs2gs` is the repository's C#→G# migration tool and gap-discovery pipeline. It lives under `tools\cs2gs\`, uses Roslyn as an external C# front end, emits canonical G#, and then validates the result through the real G# toolchain. It is sibling tooling: `gsc` does not reference Roslyn.

## Install as a global tool

`cs2gs` is published as the [`Gsharp.Cs2Gs`](https://www.nuget.org/packages/Gsharp.Cs2Gs/) .NET global tool (it requires a .NET 10 runtime):

```sh
dotnet tool install --global Gsharp.Cs2Gs
```

Once installed, the `cs2gs` command is on your `PATH`, and the examples below use it directly. Update or remove it with `dotnet tool update --global Gsharp.Cs2Gs` and `dotnet tool uninstall --global Gsharp.Cs2Gs`. When working from a source build of this repository instead, invoke the same verbs through the built assembly — `dotnet out\bin\Release\Cs2Gs.Cli\cs2gs.dll <verb>`.

## What it does

A migration run is deterministic and stage-based:

1. **Translate** C# projects into `.gs` files and `.gsproj` projects.
2. **Compile** the translated G# with `gsc`.
3. **IL-verify** the emitted assembly.
4. **Test parity** against expected output when the corpus app has a baseline.

Every run writes artifacts, `report.html`, and `summary.json` under the run directory. Failures become structured triage records so compiler/tooling gaps can be tracked instead of hidden.

## Basic usage

The tool's help reports:

```sh
cs2gs --help
```

```text
cs2gs migrate [options]
cs2gs report --run <runDir> [--out <file-or-dir>]
cs2gs coverage [--write] [--repo-root <dir>]
cs2gs triage list --run <runDir> [--gaps <file>]
cs2gs triage file-issues --run <runDir> [--gaps <file>] [--file] [--limit N] [--milestone M]
cs2gs triage sync [--gaps <file>] [--write] [--no-test-reason <why>]
```

For a normal corpus run:

```sh
cs2gs migrate --corpus tools\cs2gs\corpus --out cs2gs-runs
```

Useful `migrate` options:

| Option | Behavior |
| --- | --- |
| `--corpus <dir>` | Corpus root. Defaults to `tools\cs2gs\corpus` when run from the repository. |
| `--app <id>` | Migrate only one app. May be repeated. |
| `--via-sdk` | Build the emitted G# via `dotnet build` + the `Gsharp.NET.Sdk` (instead of invoking `gsc` directly) so source generators run. |
| `--out <dir>` | Runs root for artifacts; default is `cs2gs-runs`. |
| `--config <name>` | Build configuration used to find tools; default is `Release`. |
| `--baseline <file>` | Gate on the gap ledger. New and regressed fingerprints fail; known-open gaps are tolerated. |
| `--baseline-strict` | Also fail on stale ledger entries. Intended for nightly checks. |

## Coverage and triage

`cs2gs` keeps a construct inventory for Roslyn syntax kinds, a generated coverage matrix, and automated gap triage. `cs2gs coverage --write` updates the inventory skeleton and generated matrix when Roslyn's surface changes. `cs2gs triage` commands list and cluster run gaps, and sync the gap ledger.

## Generated code policy

`cs2gs` translates hand-authored C# and preserves the inputs that let the migrated G# build reproduce generated code. It does not freeze Roslyn source-generator output by default. For `.resx`, the migration emits a generated `Resources.Designer.gs` through the shared G# resx codebehind generator instead of translating `Resources.Designer.cs`.
