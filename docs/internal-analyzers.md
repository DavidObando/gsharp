# Internal analyzers

`GSharp.InternalAnalyzers` is wired into `src/Core/Core.csproj` as an analyzer-only project reference. Core treats warnings as errors, so any `GSA` diagnostic breaks the build.

## GSA0001: Struct field token reads

Catches direct value reads of `StructFieldDefs[field]` outside `ResolveFieldToken` and `ResolveInterfaceFieldToken`. Field tokens emitted into IL must go through those resolver methods so generic self-instantiated structs get the right MemberRef/TypeSpec token. Writes that populate the cache are allowed.

Use:

```csharp
var token = this.outer.ResolveFieldToken(structSymbol, field);
```

## GSA0002: imported CLR Type reference comparisons

Within the compiler metadata namespaces (`GSharp.Core.CodeAnalysis.Emit`, `.Symbols`, and `.Binding`), catches the high-confidence cross-load-context bug shape where a `System.Type` / `System.Reflection.TypeInfo` value is compared by reference to a `typeof(...)` literal using `==`, `!=`, or `ReferenceEquals`. A metadata-loaded type and a host-runtime `typeof(...)` value can represent the same identity without being the same object.

Use `ClrTypeUtilities.AreSame(a, b)` or `a.IsSameAs(b)` for those `typeof(...)` comparisons. Null checks are allowed, and `ClrTypeUtilities` / `TypeIdentityComparer` are exempt because they implement the sanctioned comparison.

Non-goal: GSA0002 does not flag general `Type == Type` or `ReferenceEquals(typeA, typeB)` comparisons. Within one emit pass, `ClrType` instances are canonical and reference equality is sometimes the intended exact check (for example, deciding whether an IL conversion can be skipped).

## GSA0003: strong static reflection caches

Catches static `Dictionary<K,V>` / `ConcurrentDictionary<K,V>` fields in compiler metadata areas when `K` is reflection `Type`, `Assembly`, or `Module`. Strong static keys can pin `MetadataLoadContext` instances. Use `ConditionalWeakTable<K,V>` or keep the cache on a short-lived resolver/reference instance.

## Suppressions

Avoid suppressions. If an intentional exception is unavoidable, suppress only the exact statement or field and include a one-line reason:

```csharp
#pragma warning disable GSA0002 // Symbols are canonical within this emit pass; CLR Type identity is not involved.
...
#pragma warning restore GSA0002
```

The analyzers currently gate Core only. Extending them to cs2gs is future work.
