# ADR-0028: Multi-package emit model — Option B, C#-faithful

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 0 (work item 0.8)
- **Related**: gaps doc §6.2; execution plan §0.8; design doc D-multi-package

## Context

Today's emitter (`src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs:138-145`) lumps every user `func` of a compilation into a single static `<Program>` type in the namespace given by `BoundProgram.PackageName` (`src/Core/CodeAnalysis/Binding/BoundProgram.cs:30,40`). `BoundProgram.PackageName` is a single string fed by whichever `.gs` file the compilation looked at first. The assembly is named `{PackageName}.dll`.

This works only when every `.gs` file in a `.gsproj` declares the same `package`. The user asked: what happens when one `.gsproj` legitimately wants to ship code under two namespaces (e.g., `MyApp.Core` and `MyApp.Cli`)?

Two precedents:

- **Option A — Go-faithful, one-package-per-module.** Enforce that every `.gs` file in a `.gsproj` declares the same `package`. Cross-namespace code requires a second project. Matches Go's "one package per directory" rule.
- **Option B — C#-faithful, multi-package-per-project.** A `.gsproj` is an assembly; each `.gs` file's `package` becomes a CLR namespace. One assembly can host many namespaces, exactly like a C# project can.

Cross-cutting facts:

- The CLR has no concept of "package"; it has namespaces and assemblies. Namespaces are purely a naming convention on type full-names; assemblies are the unit of deployment and the unit of `internal` visibility (ADR-0006).
- `.gsproj` already carries `<AssemblyName>` and `<RootNamespace>` MSBuild properties (`samples/HelloWorld/HelloWorld.gsproj`). These are the right places to anchor assembly identity, independent of any one file's `package`.
- The "exactly one file with top-level statements" rule from `design/Gsharp-design-v0.1.md` is preserved by narrowing it to "exactly one **package** with top-level statements" — that package owns the synthesized entry point.

## Decision

**Option B**. A `.gsproj` may contain multiple `package` declarations across its `.gs` files; each becomes a CLR namespace in the produced assembly.

- `BoundProgram` indexes its functions (and, post Phase 3, its types) by `PackageSymbol`, not by a single string.
- The emitter produces one `<Program>` static container per distinct package, each in its declaring `package X.Y` namespace.
- Assembly + module name come from `.gsproj` `<AssemblyName>` (falling back to `<RootNamespace>`, falling back to the project file name) — never from any one file's `package`.
- The "exactly one file with top-level statements" rule becomes "exactly one **package** with top-level statements"; that package's `<Program>` carries the synthesized entry point and the assembly's `EntryPoint` token points at it.
- Forward-compatible with Phase 3: user-defined `struct` / `class` / `interface` emit as ordinary `namespace.TypeName` CLR types in the declaring package's namespace, not as nested types on `<Program>`.

## Consequences

Positive:

- Matches what every C# / .NET developer expects: an assembly is a deployment unit, namespaces are an organizational unit, and a project can carry many namespaces.
- `internal` visibility (ADR-0006) gains its natural unit-of-scope (the assembly), independent of how packages are sliced.
- No new project-file ceremony for users who want a small library to expose two related namespaces.
- The Go-style "one package per directory" idiom remains _possible_ as a project convention; it is no longer _required_ by the toolchain.

Negative:

- Refactor touches `BoundProgram`, `Binder.BindGlobalScope`, `ReflectionMetadataEmitter`, `Compilation`, and SDK assembly-name plumbing. Largest single work item in Phase 0.
- Diagnostics must clarify that the entry-point-bearing package is selected by where top-level statements live, not by any "main package" convention.
- Loses the "Go-faithful" purity argument; mitigated by the observation that the CLR's organizing units are namespaces and assemblies, not packages.

Neutral:

- The single-package case continues to work unchanged: one `.gs` file, one `package` declaration, one namespace, one `<Program>` type.
- Cross-assembly `internal` access via `[InternalsVisibleTo]` is independent of this decision.

## Alternatives considered

- **Option A — one-package-per-`.gsproj`**: rejected; forces users to create multiple projects for a problem the CLR considers a single-assembly affair, fragments `internal` visibility scope, and clashes with `.NET` ecosystem expectations.
- **Hybrid — one package per directory, enforced by the SDK**: rejected for the same Option-A reasons plus the added cost of a directory-layout convention the toolchain has to enforce.

## Acceptance

A multi-file conformance fixture with two `package` declarations (e.g., `samples/MultiPackage/Core.gs` declaring `MyApp.Core` and `samples/MultiPackage/Cli.gs` declaring `MyApp.Cli`) builds into a single assembly. Reflection round-trip confirms two namespaces with their respective `<Program>` types, and the `Cli` package's top-level statements drive the entry point. Existing single-package samples (HelloWorld, Arithmetic, Loop) continue to build unchanged.
