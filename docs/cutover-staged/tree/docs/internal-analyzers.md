# Internal analyzers

`GSharp.InternalAnalyzers` (`src/Analyzers/InternalAnalyzers`) is a set of Roslyn
analyzers written in C#. They analyze C# syntax. Since the compiler became G#
source they **do not run on `Core`** (a `.gsproj` of `.gs` files), so rules
GSA0001-GSA0003 below are no longer enforced by the build.

<!-- CUTOVER-VERIFY: owner decision. Either (a) the rules are ported to G#
     analyzers (the repository already builds G# analyzers; see
     e2etests/gsanalyzer-e2e.sh and ADR-0193 phases 2-3, which write GSA0007 and
     GSA0008 in G#), and this page says "enforced by G# analyzers in <path>", or
     (b) they are retired and remain review conventions, as written below.
     Pick one, update the "Status" paragraph and delete this comment. -->

## Status

The three rules remain binding conventions for compiler source. Review for them
by hand until they are ported to G# analyzers or formally retired. The C#
analyzer project and its tests are kept as the reference implementation of each
rule's detection logic.

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
