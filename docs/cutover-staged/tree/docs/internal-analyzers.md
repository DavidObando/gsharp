# Internal analyzers

`GSharp.InternalAnalyzers` (`src/Analyzers/InternalAnalyzers`) is a set of Roslyn
analyzers. At the cut-over the project is translated to G# with the rest of the
repository, like the other analyzers cs2gs migrates
([cs2gs analyzer translation](cs2gs-analyzer-translation.md)).

## Status: GSA0001-GSA0003 retired at the cut-over (a step the cut-over PR performs)

Owner decision (2026-10-09): GSA0001-GSA0003 are retired. They are not ported.
The project also defines GSA0004-GSA0007 (GSA0007 is the ADR-0193 producer-funnel
analyzer, live in every Core build). Those stay, together with the project and the
`src/Core` reference. GSA0008 (ADR-0193) is not implemented yet and will enforce the
nullability funnel, not the three retired rules.

**Retirement is not automatic.** The cs2gs migration keeps the analyzer reference
of `src/Core` (rewritten to `OutputItemType="GsharpCodeAnalyzer"`), and
`cs2gs-analyzer-translation.md` states that the translated rules keep guarding
the migrated compiler. Neither `apply.sh` nor `cutover_edits.py` removes any rule.
To retire GSA0001-GSA0003 the cut-over PR must, by hand: delete those three
analyzers, their descriptors and their tests, and keep everything else in
`src/Analyzers/InternalAnalyzers` and the reference in `src/Core/Core.gsproj`.
If the owner prefers to keep the translated rules running, skip that step and
delete this section instead.

**Enforcement gap once retired.** The three rules below are **not enforced by the
build**. They stay as written conventions for compiler source and must be checked
in review. Violating GSA0001 or GSA0002 produced real bugs (the GS0155/0158/0159
clusters); GSA0003 caused CI out-of-memory failures. If one of them regresses,
that is the signal to port it as a G# analyzer.

## GSA0001: Struct field token reads

Catches direct value reads of `StructFieldDefs[field]` outside `ResolveFieldToken` and `ResolveInterfaceFieldToken`. Field tokens emitted into IL must go through those resolver methods so generic self-instantiated structs get the right MemberRef/TypeSpec token. Writes that populate the cache are allowed.

Use:

```gs
let token = this.outer.ResolveFieldToken(structSymbol, field)
```

## GSA0002: imported CLR Type reference comparisons

Within the compiler metadata namespaces (`GSharp.Core.CodeAnalysis.Emit`, `.Symbols`, and `.Binding`), flags the high-confidence cross-load-context bug shape where a `System.Type` / `System.Reflection.TypeInfo` value is compared by reference to a `typeof(...)` literal using `==`, `!=`, or `ReferenceEquals`. A metadata-loaded type and a host-runtime `typeof(...)` value can represent the same identity without being the same object.

Use `ClrTypeUtilities.AreSame(a, b)` or `a.IsSameAs(b)` for those `typeof(...)` comparisons. Null checks are allowed, and `ClrTypeUtilities` / `TypeIdentityComparer` are exempt because they implement the sanctioned comparison.

Non-goal: GSA0002 does not flag general `Type == Type` or `ReferenceEquals(typeA, typeB)` comparisons. Within one emit pass, `ClrType` instances are canonical and reference equality is sometimes the intended exact check (for example, deciding whether an IL conversion can be skipped).

## GSA0003: strong static reflection caches

Flags static `Dictionary[K, V]` / `ConcurrentDictionary[K, V]` fields in compiler metadata areas when `K` is reflection `Type`, `Assembly`, or `Module`. Strong static keys can pin `MetadataLoadContext` instances. Use `ConditionalWeakTable[K, V]` or keep the cache on a short-lived resolver/reference instance.

## Suppressions

Avoid suppressions. If an intentional exception is unavoidable, suppress only the exact member or statement with `@SuppressDiagnostic` (ADR-0175) and include a one-line reason:

```gs
@SuppressDiagnostic("GSA0002") // Symbols are canonical within this emit pass; CLR Type identity is not involved.
```
