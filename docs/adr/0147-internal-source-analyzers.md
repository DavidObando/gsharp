# ADR-0147: Internal source analyzers

- **Status**: Accepted
- **Date**: 2026-07-14
- **Phase**: Compiler hardening
- **Related**: internal antipattern audit clusters A, B, G

## Context

The compiler has a few C# implementation invariants that are easy to regress and hard to catch with language tests alone. Three recent audit clusters found repeatable bug shapes: direct emission of cached field definitions, reference equality on imported CLR `System.Type` values, and static strong caches keyed by reflection identity objects.

Core projects already build with `TreatWarningsAsErrors=true`, so analyzer warnings can be used as a hard local and CI gate as long as the analyzers are precise enough to produce zero diagnostics on the current tree.

## Decision

Add `GSharp.InternalAnalyzers`, a netstandard2.0 Roslyn analyzer assembly, and wire it into `src/Core/Core.csproj` as an analyzer-only project reference. The suite defines warning diagnostics with the `GSA` prefix:

- `GSA0001`: direct `StructFieldDefs[field]` value reads outside `ResolveFieldToken` and `ResolveInterfaceFieldToken` are forbidden; emit paths must call those resolver choke points.
- `GSA0002`: within Core metadata namespaces, reference comparisons between `System.Type` / `System.Reflection.TypeInfo` values and `typeof(...)` literals are forbidden; code must use `ClrTypeUtilities.AreSame(...)` or `.IsSameAs(...)`.
- `GSA0003`: static `Dictionary` / `ConcurrentDictionary` fields keyed by reflection `Type`, `Assembly`, or `Module` in compiler metadata areas are forbidden; use `ConditionalWeakTable` or instance-scoped caches.

Because Core treats warnings as errors, any emitted `GSA` diagnostic fails the build.

## Consequences

The compiler now has executable guardrails for the three audited antipatterns, including unit tests for positive cases and precision exemptions. Analyzer enforcement currently gates Core only; extending the same rules to cs2gs is future work after concurrent cs2gs edits settle.

The analyzers intentionally stay narrow to avoid blocking unrelated existing implementation patterns. GSA0002 is scoped to Core metadata namespaces and deliberately does not flag general `Type == Type` comparisons, because canonical `ClrType` reference equality is intended within a single emit pass. Intentional exceptions should be suppressed at the exact site with `#pragma warning disable GSAxxxx` and a one-line reason.

## Alternatives considered

- Rely on comments and review: rejected because the previous bugs were small local edits that are easy to miss.
- Add broad grep checks: rejected because these rules need semantic type information and write/read distinction.
- Gate every project immediately: rejected to avoid conflicting with in-flight cs2gs work; Core is the first enforced target.
