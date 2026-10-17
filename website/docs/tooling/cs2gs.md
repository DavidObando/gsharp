---
title: "C# to G# migration (cs2gs)"
sidebar_position: 3
draft: false
description: "Translate C# projects to G# and understand the migration tool's verification stages and limits."
---

# C# to G# migration (`cs2gs`)

`cs2gs` translates a C# repository into a G# repository. It reads C# with Roslyn, emits canonical G#, and then checks the result with the real G# toolchain. `gsc` itself does not reference Roslyn.

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
4. **Test parity**: run the migrated tests and compare the results with the C# tests.

Every run writes `report.html` and `summary.json`. Each failure becomes a structured record, so you can see which construct or stage failed.

## Basic usage

```sh
cs2gs migrate --help
```

The main verbs are:

```text
cs2gs migrate [options]
cs2gs validate --corpus <repo-root> --migrated <dir> [--shard i/N | --app <id>...]
cs2gs capture-test-oracle --corpus <repo-root> --out <dir> [--exclude <path>...]
cs2gs report --run <runDir> [--out <file-or-dir>]
```

To migrate a C# repository into an empty destination directory:

```sh
cs2gs migrate --corpus path/to/csharp-repo --out path/to/gsharp-repo
```

The destination keeps the source's relative directories. `cs2gs` translates checked-in `.cs` files to `.gs`, transforms `.csproj` files to `.gsproj`, mirrors each `.sln`, and copies non-C# files. Build outputs, logs and reports go to a separate artifacts directory, `<out>.cs2gs-runs` by default.

Useful `migrate` options:

| Option | Behavior |
| --- | --- |
| `--corpus <dir>` | Root of the C# repository to migrate. |
| `--out <dir>` | Empty destination directory for the G# repository. |
| `--artifacts <dir>` | Directory for build outputs, logs and reports. The default is `<out>.cs2gs-runs`. |
| `--exclude <path>` | Leave out projects whose repository-relative path starts with `<path>`. May be repeated. |
| `--passthrough <path>` | Do not translate matching projects, but keep their original C# project and sources in the destination. May be repeated. |
| `--sdk-version <v>` | Pin `Gsharp.NET.Sdk` to exactly `<v>`. A version published on NuGet works. |
| `--sdk-pin <where>` | `project` (the default) writes the SDK version into each generated project. `global-json` writes it under `msbuild-sdks` in `global.json` and leaves the project `Sdk` attributes unversioned. |
| `--via-sdk` | Build the emitted G# via `dotnet build` + the `Gsharp.NET.Sdk` so source generators run. This is the default. |
| `--no-via-sdk` | Compile with `gsc` directly instead of the SDK build. |
| `--config <name>` | Build configuration used to find tools; default is `Release`. |
| `--stop-after <stage>` | Run the stages up to and including `translate`, `compile`, `ilverify` or `test-parity` (the default). `compile` includes the redundant-`!!` cleanup, so the migrated tree is final without running test parity. |
| `--translate-only` | Run only the translate stage, and write a `validation-context.json` for each project so `cs2gs validate` can run the other stages later. |
| `--format` | Run the canonical formatter over emitted G#. This is the default. |
| `--no-format` | Keep the printer's own layout instead of the canonical one. The emitted G# is the same program either way; only its line breaks differ. |

The exit code is non-zero if any project fails a stage.

## Validate a translated repository

`cs2gs validate` runs the compile, IL-verify and test-parity stages on a tree that `migrate --translate-only` already produced. Use it to split a large repository across several machines. Give it the original C# checkout, the migrated tree, and the run directory that holds the `validation-context.json` files:

```sh
cs2gs capture-test-oracle --corpus path/to/csharp-repo --out csharp-tests

cs2gs validate --corpus path/to/csharp-repo --migrated path/to/gsharp-repo \
  --manifests path/to/runs/<run-id> --csharp-test-oracle csharp-tests \
  --shard 1/4
```

`capture-test-oracle` records the C# test-case names, and `validate` compares the migrated tests with them name for name. Use `--count-only-test-parity` to skip the per-name check.

Pass the same `--exclude` and `--passthrough` values that the `migrate` run used. They define the set of projects, so a different list breaks project references. To select a subset, use `--app <id>` or `--shard <i>/<N>` instead.

`validate` reads the original C# sources only from the `--corpus` checkout. It fails when a source is missing, when a path is outside the checkout or the migrated tree, or when a manifest does not identify its owning project. In those cases, run a new `migrate --translate-only` pass.

## Roslyn analyzer projects

When a project in the migration declares Roslyn analyzers, `cs2gs` switches that project into analyzer translation mode: `Microsoft.CodeAnalysis` usage is rewritten to the [G# analyzer API](./analyzers.md) instead of passing through as an ordinary library reference. The `[DiagnosticAnalyzer]` attribute, base class, analysis contexts, `SyntaxKind` values, and node/symbol members all map to their G# counterparts, and common idioms are rewritten (`GetLocation()` becomes `.Location`, operation actions become bound-node actions, and so on). The project file is retargeted too: the Roslyn compiler packages are dropped in favor of a `GSharp.Core` reference, and consumers' `OutputItemType="Analyzer"` wiring becomes `OutputItemType="GsharpCodeAnalyzer"`.

Where C# and G# syntax genuinely differ in shape, the translator adapts the detection logic and flags the site with a `CS2GS-ANALYZER-SHAPE` warning for review; APIs it cannot map are reported loudly rather than translated wrong. Analyzer *test* snippets translate as well, with their `[|…|]` expected-diagnostic markers re-placed in the G# source and any unplaceable marker called out with `CS2GS-ANALYZER-SNIPPET`.

## Generated code policy

`cs2gs` translates hand-authored C# and preserves the inputs that let the migrated G# build reproduce generated code. It does not freeze Roslyn source-generator output by default. For `.resx`, the migration emits a generated `Resources.Designer.gs` through the shared G# resx codebehind generator instead of translating `Resources.Designer.cs`.
