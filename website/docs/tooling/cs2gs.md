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

Once installed, the `cs2gs` command is on your `PATH`. Update or remove it with `dotnet tool update --global Gsharp.Cs2Gs` and `dotnet tool uninstall --global Gsharp.Cs2Gs`. When working from a source build of this repository instead, invoke the same verbs through the built assembly — `dotnet out\bin\Release\Cs2Gs.Cli\cs2gs.dll <verb>`. A migration also needs the setup in [Requirements](#requirements).

## What it does

A migration run is deterministic and stage-based:

1. **Translate** C# projects into `.gs` files and `.gsproj` projects.
2. **Compile** the translated G# with `gsc`.
3. **IL-verify** the emitted assembly.
4. **Test parity**: run the migrated tests. They must pass, and at least as many must run as the C# projects declare `[Fact]` methods. This minimum does not count `[Theory]` cases. To compare the test cases name for name, pass `--csharp-test-oracle` (see [Validate a translated repository](#validate-a-translated-repository)).

Every run writes `report.html` and `summary.json`. Each failure becomes a structured record, so you can see which construct or stage failed.

## Requirements

A migration needs these tools, in addition to `cs2gs`:

- **A `gsc.dll`.** `cs2gs` looks for `out/bin/<config>/Compiler/gsc.dll` in the current directory and its parents, which a source build of G# provides. Otherwise, pass `--gsc <path>`. The `Gsharp.NET.Sdk` package contains the compiler at `tools/compiler/gsc.dll`, for example under `~/.nuget/packages/gsharp.net.sdk/<version>/` after you restore a G# project.
- **An SDK version.** Pass `--sdk-version <v>` with a `Gsharp.NET.Sdk` version that is on NuGet. Without it, `cs2gs` looks for a locally packed SDK and stops if it finds none.
- **The `ilverify` tool.** The IL-verify stage runs `dotnet tool run ilverify`. Add `dotnet-ilverify` to a local tool manifest in the directory you run `cs2gs` from (`dotnet new tool-manifest`, then `dotnet tool install dotnet-ilverify`).
- **A `.nugs` directory.** The `nuget.config` that `cs2gs` generates for the destination lists `.nugs` under the C# source root (the `CS2GS_TEST_SOURCE_ROOT` directory below) as a local package source. Restore fails with `NU1301` for any project with package references until that directory exists. Create it before you run `migrate` (`mkdir path/to/csharp-repo/.nugs`).

Known limitation ([#4956](https://github.com/DavidObando/gsharp/issues/4956)): the published tool also looks for the G# source tree, and outside it `migrate` stops with "Could not locate the repository source root". Until this is fixed, set the `CS2GS_TEST_SOURCE_ROOT` environment variable to the root of the C# repository:

```sh
mkdir -p path/to/csharp-repo/.nugs
CS2GS_TEST_SOURCE_ROOT=path/to/csharp-repo cs2gs migrate \
  --corpus path/to/csharp-repo --out path/to/gsharp-repo \
  --gsc ~/.nuget/packages/gsharp.net.sdk/<version>/tools/compiler/gsc.dll \
  --sdk-version <version>
```

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

To migrate a C# repository into an empty destination directory (add the options from [Requirements](#requirements)):

```sh
cs2gs migrate --corpus path/to/csharp-repo --out path/to/gsharp-repo
```

The destination keeps the source's relative directories. `cs2gs` translates checked-in `.cs` files to `.gs`, transforms `.csproj` files to `.gsproj`, mirrors each `.sln`, and copies non-C# files. Build outputs, logs and reports go to a separate artifacts directory, `<out>.cs2gs-runs` by default.

For Git sources, supply the working-tree root.
The destination keeps an independent copy of the source Git history without checking out the original files.
Version tasks use that history instead of a repository above the destination.
The translated files remain uncommitted.
Linked working trees work as source roots.
`cs2gs` rejects source subdirectories because their new relative paths cannot preserve history-based version calculations.
An archive without Git history gets an empty destination repository.
Its version files stay unchanged.

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
| `--allow-conditional-compilation` | Report each C# `#if`/`#elif` as a `CS2GS-CONDITIONAL-COMPILATION` warning and translate the active arm, instead of failing. G# has no conditional compilation. This applies to the translate stage only. |
| `--via-sdk` | Build the emitted G# via `dotnet build` + the `Gsharp.NET.Sdk` so source generators run. This is the default. |
| `--no-via-sdk` | Compile with `gsc` directly instead of the SDK build. |
| `--config <name>` | Build configuration used to find tools; default is `Release`. |
| `--csharp-test-oracle <dir>` | Compare the migrated tests with the C# test-case names that `cs2gs capture-test-oracle` wrote to `<dir>`. |
| `--gsc <path>` | Use this `gsc.dll`. See [Requirements](#requirements). |
| `--stop-after <stage>` | Run the stages up to and including `translate`, `compile`, `ilverify` or `test-parity` (the default). `compile` includes the redundant-`!!` cleanup, so the migrated tree is final without running test parity. |
| `--translate-only` | Run only the translate stage, and write a `validation-context.json` for each project so `cs2gs validate` can run the other stages later. |
| `--format` | Run the canonical formatter over emitted G#. This is the default. |
| `--no-format` | Keep the printer's own layout instead of the canonical one. The emitted G# is the same program either way; only its line breaks differ. |

The exit code is non-zero if any project fails a stage.

## What translation changes

`cs2gs` makes the changes below to every C# file it translates. Most of them change only the text of the code. The modifier rules can also change whether a class can be inherited from, and the accessibility of `protected internal` and `private protected` members. Check these changes when you review a migrated repository.

### Comments and directives

- `cs2gs` keeps `//`, `/* */` and `///` comments on the lines above a type, a member or a statement. It rewrites `/* */` comments as `//` lines and `///` comments as G# documentation comments.
- `cs2gs` also keeps a `//` comment at the end of a statement's line, and the comments just before the closing brace of a block.
- `cs2gs` drops comments in other places, such as a comment at the end of a member declaration's line. It also drops `/** */` documentation comments. Review the comments after you migrate.
- A license or copyright header at the top of a C# file stays at the top of the G# file.
- `cs2gs` drops `#region` and `#endregion` lines. It translates the code between them as usual.
- `cs2gs` also drops the other directive lines, such as `#nullable`, `#define`, `#line`, `#error` and `#warning`. G# has no preprocessor.
- `cs2gs` reports every `#if` and `#elif` as a `CS2GS-CONDITIONAL-COMPILATION` error, including those in inactive branches, and the translate stage fails. G# has no conditional compilation. With [`--allow-conditional-compilation`](#basic-usage), `cs2gs` reports a warning instead and translates only the branch that is active under the project's preprocessor symbols. Before you migrate, rewrite such code as a runtime check or delete the branch you don't need.

### Warning suppressions

`cs2gs` turns the range that a `#pragma warning disable` covers, up to the matching `#pragma warning restore` or the end of the file, into a `@SuppressDiagnostic` annotation for these IDs only:

- An ID that starts with `GSA` (a G# analyzer) keeps its ID.
- `CS8600`, `CS8601`, `CS8604` and `CS8620` become `GS0612`. These are the C# nullability warnings that gsc reports as `GS0612` at a `ref`, `out` or `in` argument.

`cs2gs` drops every other ID, such as `CA*`, `IDE*`, `SA*` and the other `CS*` warnings, because those analyzers don't run on G# code. It also drops a `#pragma warning disable` that names no ID. The `#pragma warning` lines themselves don't appear in the G# file.

The annotation goes on each method, property, field, constructor, event or finalizer that the range covers completely. A range that spans a whole file puts the annotation on every member in it. A range that starts or ends inside a member suppresses nothing in that member, so gsc reports the warning there.

`cs2gs` also adds `@SuppressDiagnostic("GS0612")` to a statement that passes `x!` as a `ref`, `out` or `in` argument to a method in the migrated code, when the variable's nullability differs from the parameter's. G# has no `!` on a variable, so the annotation keeps the warning silent, as it was in C#. Where the annotation can't go on the statement without changing what the code means, such as on a `using` declaration, `cs2gs` leaves it out and gsc reports the warning.

### Member order and layout

- In a class or struct, instance members keep their source order. `cs2gs` moves the static members, in source order, into one `shared { }` block after the instance members.
- A `static class` becomes a `shared class`, with no `shared { }` block. Its nested types come first, then its other members in source order.
- Nested types stay in the body of the enclosing type, in source order among the instance members.
- Operator overloads become top-level functions. Conversion operators (`implicit` and `explicit`) and compound-assignment operators are the exception: they stay in the type.
- Delegate types declared inside a type become top-level declarations.
- Extension methods in a static class usually become top-level receiver functions. Some stay in the class as static methods, for example when the receiver form would collide with another overload. An extension method on a type that the project declares can instead move into that type.
- `cs2gs` places the new top-level declarations right after the top-level type that contained them.
- G# has no property initializer. For an auto-property declared `{ get; }` or `{ get; init; }`, `cs2gs` moves the initial value to the start of each constructor that doesn't call `this(...)`.
  - A class with no constructor gets a synthesized `init()` that sets the values. If the class has a primary constructor, the synthesized `init` takes its parameters.
  - If a primary-constructor parameter is also used elsewhere in the class, `cs2gs` reports an error and drops the initial values.
  - A `{ get; }` property that is static, `virtual` or `override`, or that is declared in a record, keeps its initial value on a backing field instead.
- `cs2gs` doesn't keep the C# blank lines. Statements inside a body have no blank lines between them. With the default formatting, one blank line separates members.

### Modifiers

- `cs2gs` omits `public`, because it is the default in G#.
- `protected internal` and `private protected` become `internal`, with a warning. G# has no spelling for either.
- G# classes are sealed unless they are `open`, so `cs2gs` never writes `sealed` on a class. A C# class that isn't `sealed` becomes an `open` class when any of these is true:
  - it is abstract;
  - it declares a `virtual` or `abstract` member;
  - it declares a `protected`, `protected internal` or `private protected` member;
  - a class in the same project derives from it;
  - it and every type that encloses it are visible outside the assembly;
  - it is the element type of an Entity Framework Core `DbSet<T>` property.

  Otherwise it becomes a sealed G# class.
- A `sealed` C# class stays sealed, unless it declares a `protected` member that doesn't override a base member. G# allows that member only in an `open` class, so `cs2gs` emits the class as `open`.
- A method, property or indexer gets `open` when it is `virtual` or an override, isn't `sealed`, and its class is `open`.

## Validate a translated repository

`cs2gs validate` runs the compile, IL-verify and test-parity stages on a tree that `migrate --translate-only` already produced. Use it to split a large repository across several machines. Give it the original C# checkout, the migrated tree, and the run directory that holds the `validation-context.json` files:

```sh
cs2gs capture-test-oracle --corpus path/to/csharp-repo --out csharp-tests

cs2gs validate --corpus path/to/csharp-repo --migrated path/to/gsharp-repo \
  --manifests path/to/runs/<run-id> --csharp-test-oracle csharp-tests \
  --shard 1/4
```

`capture-test-oracle` records the C# test-case names, and `validate` compares the migrated tests with them name for name. `validate` requires either `--csharp-test-oracle` or `--count-only-test-parity`. The second option skips the per-name check and keeps only the minimum-count check, which does not detect lost `[Theory]` cases.

Pass the same `--exclude` and `--passthrough` values that the `migrate` run used. They define the set of projects, so a different list breaks project references. To select a subset, use `--app <id>` or `--shard <i>/<N>` instead.

`validate` reads the original C# sources only from the `--corpus` checkout. It fails when a source is missing, when a path is outside the checkout or the migrated tree, or when a manifest does not identify its owning project. In those cases, run a new `migrate --translate-only` pass.

## Roslyn analyzer projects

When a project in the migration declares Roslyn analyzers, `cs2gs` switches that project into analyzer translation mode: `Microsoft.CodeAnalysis` usage is rewritten to the [G# analyzer API](./analyzers.md) instead of passing through as an ordinary library reference. The `[DiagnosticAnalyzer]` attribute, base class, analysis contexts, `SyntaxKind` values, and node/symbol members all map to their G# counterparts, and common idioms are rewritten (`GetLocation()` becomes `.Location`, operation actions become bound-node actions, and so on). The project file is retargeted too: the Roslyn compiler packages are dropped in favor of a `GSharp.Core` reference, and consumers' `OutputItemType="Analyzer"` wiring becomes `OutputItemType="GsharpCodeAnalyzer"`.

Where C# and G# syntax genuinely differ in shape, the translator adapts the detection logic and flags the site with a `CS2GS-ANALYZER-SHAPE` warning for review; APIs it cannot map are reported loudly rather than translated wrong. Analyzer *test* snippets translate as well, with their `[|…|]` expected-diagnostic markers re-placed in the G# source and any unplaceable marker called out with `CS2GS-ANALYZER-SNIPPET`.

## Generated code policy

`cs2gs` translates hand-authored C# and preserves the inputs that let the migrated G# build reproduce generated code. It does not freeze Roslyn source-generator output by default. For `.resx`, the migration emits a generated `Resources.Designer.gs` through the shared G# resx codebehind generator instead of translating `Resources.Designer.cs`.
