# ADR-0021: Generic variance modifiers — `in` / `out` on interface type parameters

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 4 (lock before 4.3)
- **Related**: ADR-0004 (generics scope), ADR-0020 (generic brackets); execution plan §4.3

## Context

CLR generics support **declaration-site variance** on **interface and delegate** type parameters:

- `out T` — *covariant*. `IEnumerable<out T>` lets `IEnumerable<string>` flow to `IEnumerable<object>` because `T` only appears in *output* positions.
- `in T` — *contravariant*. `IComparer<in T>` lets `IComparer<object>` flow to `IComparer<string>` because `T` only appears in *input* positions.
- No annotation — *invariant*. `List<T>` is invariant because `T` appears in both positions.

Variance is **not** a runtime feature; it is enforced by the verifier and shapes which assignments are legal. GSharp must surface it because:

1. GSharp consumes BCL interfaces that *use* variance (`IEnumerable<out T>`, `IComparable<in T>`, `Func<in T, out R>` delegates, …); not modelling variance forces users into explicit casts where C# would not require them.
2. GSharp authors will write their own interfaces (Phase 3.B.4 already lights up `interface` declarations) and need a way to opt their type parameters into variance.

This ADR fixes the GSharp surface syntax for variance and the binder/emit semantics.

## Decision

Adopt **declaration-site variance** with the **same keywords as C#** — `in` and `out` — placed **immediately before the type parameter** inside the type-parameter list brackets, **only on `interface` declarations** (and, when Phase 4.7 lands, delegate-like first-class function types).

```
interface Producer[out T] {
    func produce() T
}

interface Consumer[in T] {
    func consume(value T)
}

interface Comparer[in T] {
    func compare(a T, b T) int
}

interface Func[in TArg, out TResult] {
    func invoke(arg TArg) TResult
}
```

### Surface grammar

```
TypeParamList   := '[' TypeParam (',' TypeParam)* ']'
TypeParam       := Variance? IDENT Constraint?
Variance        := 'in' | 'out'
Constraint      := IDENT          // 'any', 'comparable', or sealed-interface name
```

`in` and `out` become **contextual keywords**: they are reserved **only** inside a `TypeParamList`. Elsewhere `in` and `out` remain plain identifiers, preserving compatibility with user code that uses them as variable names.

### Where variance is allowed

| Declaration | Variance allowed? |
| --- | --- |
| `interface I[…]` | Yes — `in` / `out` per parameter |
| `class C[…]` | No — binder diagnostic |
| `struct S[…]` | No — binder diagnostic (CLR forbids) |
| `data struct D[…]` | No — same as struct |
| `func F[…](…)` | No — methods are invariant in their type parameters |
| First-class function type `func(in T) out R` (Phase 4.7) | Yes — desugars to `Func[in T, out R]` once `func[…]` types map to BCL `Func<…>` delegates |

### Position-checking

The binder performs the standard variance check during interface binding (Phase 3.B.4 left a stub at `Binder.VerifyInterfaceImplementations` — variance checking lands in `BindInterfaceMembers`):

- For each `out T` parameter, every appearance of `T` in member signatures must be in a **covariant** position (method return type, `out` parameter, or covariant position of another `out` parameter).
- For each `in T` parameter, every appearance must be in a **contravariant** position (regular parameter or contravariant position of another `out` parameter).
- For invariant `T`, no restriction.

Violation emits a focused diagnostic: `type parameter 'T' is declared 'out' but used in a contravariant position in 'I.consume'`.

### CLR emission

Variance is encoded in the **`GenericParameter`** metadata row via the `GenericParameterAttributes` flags:

- `out T` → `GenericParameterAttributes.Covariant`
- `in T`  → `GenericParameterAttributes.Contravariant`
- invariant → `GenericParameterAttributes.None`

`ReflectionMetadataEmitter` already emits interface TypeDefs; Phase 4.3 extends `EmitInterfaceDeclaration` to attach the variance attribute when adding `GenericParam` rows.

### Imported interfaces

`ImportedTypeSymbol` reads variance from `Type.GetGenericArguments()[i].GenericParameterAttributes` and re-exposes it via a new `Variance` enum on `TypeParameterSymbol`. Assignment compatibility (`IEnumerable<string>` → `IEnumerable<object>`) is checked in the binder by walking the type-argument list of source vs target and applying variance per parameter.

## Consequences

- The lexer is unchanged. `in` and `out` keyword status is contextual to inside `[ … ]` of a `TypeParamList`.
- One new enum (`Variance`) on `TypeParameterSymbol`.
- One new emitter helper that maps `Variance` → `GenericParameterAttributes`.
- One new binder pass (`VerifyVariancePositions`) on interface members, mirroring the C# rule.
- Assignment compatibility logic in `Conversion.Classify` extends to cover variant interface conversions.
- Users of GSharp gain idiomatic `IEnumerable<T>` semantics without explicit casts.

## Alternatives considered

- **Use-site variance** (Java wildcards, `? extends T` / `? super T`) — rejected: ramifies through every type-clause occurrence in the language, much more parser surface, and CLR doesn't natively support it. Could be layered on later if needed.
- **No variance** (treat all interfaces as invariant) — rejected: would force casts on every consumer of `IEnumerable<T>`, the single most-used variant interface in the BCL.
- **Different keywords** (`+T` / `-T` like Scala) — rejected: visually noisy and unfamiliar to C# / Go audiences; `in` / `out` map 1-to-1 to the CLR metadata names.

## Open follow-ups

- Variance on first-class function types (Phase 4.7) — depends on how `func(int) string` lowers to BCL delegates. Cover in a Phase-4.7 follow-up note.
- Diagnostic wording for variance violations — settle during 4.3 implementation.
