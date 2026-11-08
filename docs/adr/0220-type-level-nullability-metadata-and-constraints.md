# ADR-0220: Type-level nullability metadata and generic nullability constraints

- **Status**: Accepted
- **Date**: 2026-11-07
- **Phase**: Nullability & CLR Interop
- **Related**: [#4996](https://github.com/DavidObando/gsharp/issues/4996), [#4988](https://github.com/DavidObando/gsharp/issues/4988), [ADR-0097](0097-generic-type-parameter-flag-constraints.md), [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md), [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md)

## Context

Method, field, property, and event signatures emit and read Roslyn-compatible `[Nullable]` and `[NullableContext]` metadata (#4988), but four type-level metadata positions still lacked writer and reader support (#4996):

1. Base-type generic arguments (`class C : Base[Token?]`) on the `TypeDef` row.
2. Implemented-interface generic arguments (`class C : IFoo[Token?]`) on the `InterfaceImpl` row.
3. Generic parameter constraint types (`[T IEquatable[Token?]]`, `[T Base?]`, `[T IFoo?]`) on the `GenericParamConstraint` row.
4. A generic parameter's own nullability contract (`[T]`, `[T class]`, `[T class?]`, `[T notnull]`) on the `GenericParam` row.

Without metadata on these rows, C# consumers could not distinguish nullable from non-nullable type arguments on G# base types, interfaces, and generic constraints, and G# could neither express nor enforce C#'s `where T : class?`, `where T : notnull`, or nullable class/interface bounds (`where T : Base?`, `where T : IFoo?`) across assemblies.

## Decision

1. **Constraint syntax**:
   - `ConstraintFlag` adds `class?` (nullable reference-type constraint) and contextual `notnull` (non-nullable value or reference type constraint).
   - `ConstraintRef` permits a trailing `?` on class and interface bounds (`[T Base?]`, `[T IFoo?]`).
   - Mutually exclusive flag combinations (`class class?`, `class notnull`, `class? notnull`, `class? struct`, `notnull struct`, `notnull unmanaged`) report **GS0361**. `notnull` may combine with an interface or nullable bound (`[T IDisposable notnull]`, `[T Base? notnull]`).
   - Partial method declarations and implementations must declare matching `class`, `class?`, and `notnull` constraints (**GS0611**).

2. **Metadata emission (`NullableFlagsBuilder` / `CustomAttributeEncoder` / `TypeNullabilityPlan`)**:
   - `TypeDef` base-type generic arguments emit `[Nullable]` on the `TypeDef` row with leading `1` followed by the base type's argument flags, elided when uniform with the type's `[NullableContext]`.
   - `InterfaceImpl` rows emit `[Nullable]` on the `InterfaceImpl` handle with leading `1` followed by the interface's argument flags.
   - `GenericParamConstraint` rows emit `[Nullable]` on the `GenericParamConstraint` handle encoding the bound's top-level and nested nullability flags.
   - `GenericParam` rows emit `[Nullable(2)]` for unconstrained type parameters, `class?` parameters, and parameters whose only bounds are nullable (`[T Base?]`, `[T IFoo?]`, or forwarded nullable dependent bounds), and `[Nullable(1)]` for `notnull` parameters when the enclosing `[NullableContext]` is not `1`.

3. **Metadata import (`ClrNullability` / `ClrSignatureMetadata`)**:
   - `ClrNullability.GetBaseTypeSymbol`, `GetInterfaceTypeSymbols`, `GetGenericParameterConstraintTypeSymbols`, `GetGenericParameterTypeSymbol`, and `HasNotNullConstraint` read `[Nullable]` and enclosing `[NullableContext]` from `TypeDef`, `InterfaceImpl`, `GenericParamConstraint`, and `GenericParam` handles.
   - Relationship readers normalize the leading `1` byte of `TypeDef` and `InterfaceImpl` `[Nullable]` payloads while preserving single-byte scalar payloads expanded across the target type's nullability positions.

4. **Binder constraint and receiver enforcement**:
   - Local and imported generic instantiations, constraint forwarding, and `adapt[...]` verify `class`, `class?`, `notnull`, and top-level/nested nullability on class, interface, and dependent type-parameter bounds.
   - A type parameter whose bounds allow `nil` (such as `[T Base?]`, `[T IFoo?]`, or `[T class?]` without a separate `notnull` or non-nullable class/interface bound) requires a non-null proof (`x!!`, `x?.Member`, or flow narrowing `if x != nil`) before instance member reads, writes, indexers, calls, or implicit conversions to non-nullable bound or `object` targets.

## Consequences

- G# and C# emit identical `[Nullable]` and `[NullableContext]` bytes across `TypeDef`, `InterfaceImpl`, `GenericParam`, and `GenericParamConstraint` rows in the `#4988` / `#4996` twin matrix.
- Cross-assembly and local generic constraints enforce `class`, `class?`, `notnull`, and annotated class/interface bounds uniformly.
