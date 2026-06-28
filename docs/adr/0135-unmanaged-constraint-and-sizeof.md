# ADR-0135: `unmanaged` type-parameter constraint and `sizeof(T)` expression

- **Status**: Accepted
- **Date**: 2026-07-04
- **Phase**: Binder + emit hardening (unsafe generics)
- **Closes**: Issue #1336 (G# language gap — generic unsafe SIMD over an `unmanaged`-constrained type parameter `T` is unsupported: `sizeof(T)` reported GS0130/GS0125 and `*T` reported GS0398)
- **Related**: ADR-0097 (`class`/`struct`/`init()` flag-style type-parameter constraints — `unmanaged` is a new member of that flag family); ADR-0122 (unsafe-context unmanaged pointers — source of GS0398, now widened to admit pointers to an `unmanaged`-constrained type parameter); ADR-0020 (generic bracket constraint slot); ADR-0088 (constraint-aware overload resolution); issue #914 (Oahu migration — the real-world driver)

## Context

The Oahu corpus (`Oahu.Decrypt/Mpeg4/Util/HelperExtensions.cs`) contains
`unsafe` generic SIMD helpers shaped like:

```csharp
private static unsafe bool AllLessThanOrEqual_256<T>(Span<T> ints, T value, out int checkedcount)
    where T : unmanaged, IComparable<T>
{
    int vecSize = 256 / 8 / sizeof(T);   // sizeof over a generic type parameter
    ...
    fixed (T* p = ints) { ... }          // pointer to a generic type parameter
}
```

Two G# language gaps blocked porting this code:

1. **`sizeof(T)` over a generic type parameter** had no user-facing surface
   syntax at all. `sizeof` existed only as an *internal* bound node
   (`BoundSizeOfExpression`) used to lower pointer arithmetic; a source-level
   `sizeof(T)` parsed as a call to an undefined function `sizeof`, producing
   `GS0130` ("Function 'sizeof' doesn't exist") and `GS0125` ("Variable 'T'
   doesn't exist").
2. **`*T` (a pointer to a type parameter)** was rejected by the ADR-0122
   pointer-pointee blittability gate with `GS0398` ("Unmanaged pointer to 'T'
   is not supported"), because a bare type parameter is not statically known to
   be blittable.

Both are legal on the CLR **specifically because of the `unmanaged`
constraint**: the CIL `sizeof` opcode accepts a generic type token, and the
runtime permits a pointer to an `unmanaged`-constrained type parameter. But G#
had no spelling for the `unmanaged` constraint, so neither capability could be
unlocked. This ADR adds the constraint and the `sizeof(T)` expression, and
widens the pointer gate.

## Decision

### 1. `unmanaged` constraint spelling

The `[…]` flag-constraint slot introduced by ADR-0097 is widened with a fourth
flag keyword, `unmanaged`:

```
constraint-spec  ::= 'any' | 'comparable' | InterfaceName generic-args?
                   | 'class' | 'struct' | 'init' '(' ')' | 'unmanaged'
```

```
func sizeOf[T unmanaged](sample T) int32 { return sizeof(T) }
unsafe func first[T unmanaged](p *T) T { return *p }
func cmp[T IComparable[T] unmanaged](a T, b T) int32 { return a.CompareTo(b) }
```

`unmanaged` is a **contextual** keyword — only a constraint inside a generic
type-parameter list. It may be combined with a single legacy interface bound
that precedes it (interface-first ordering, e.g. `[T IComparable[T] unmanaged]`,
matching ADR-0097's "legacy slot precedes flags slot" rule).

**Conflicts.** `unmanaged` implies `struct` (a non-nullable value type), so the
binder rejects the redundant/contradictory combinations `unmanaged struct`,
`unmanaged class`, and `unmanaged init()` with **GS0361** (the same
mutually-exclusive-constraint diagnostic introduced by ADR-0097), recovering by
keeping `unmanaged`.

### 2. Constraint satisfaction (`Binder.SatisfiesConstraint`)

`unmanaged` is checked via `Binder.IsUnmanagedTypeForConstraint(arg)`:

- A **type parameter** satisfies it when it itself carries `HasUnmanagedConstraint`.
- Any other type is classified by `BlittableDetector.IsUnmanaged(type)`.

"Unmanaged" is **broader than "blittable"**: `bool`, `char`, and `decimal` are
unmanaged (legal `sizeof` / `where T : unmanaged`) but are *not* blittable for
marshalling. `IsUnmanaged` therefore accepts those primitives, enums (G# and
CLR), pointers, and value structs whose fields are all (recursively) unmanaged,
while rejecting reference types. A failing substitution reports `GS0152` with
`DescribeConstraint` printing `"unmanaged"`.

### 3. `sizeof(T)` expression

A new `SizeOfExpressionSyntax` (`SyntaxKind.SizeOfExpression`) mirrors
`typeof(T)`: `sizeof` `(` *type-clause* `)`. It is recognized contextually so
existing code that uses `sizeof` as an identifier is unaffected. The binder
(`ExpressionBinder.BindSizeOfExpression`) validates the operand with
`Binder.IsUnmanagedTypeForConstraint`; a non-unmanaged operand (e.g.
`sizeof(string)`, or `sizeof(T)` where `T` is unconstrained) reports the new
**GS0415**. A valid operand produces the existing `BoundSizeOfExpression`, whose
emit (`EmitSizeOf` → CIL `sizeof <token>` via `GetElementTypeToken`) already
accepts a generic type token, so `sizeof(T)` lowers to a single verifiable
`sizeof !!T` instruction. `sizeof(int32)` / `sizeof(SomeStruct)` continue to
work.

### 4. `*T` pointer over an `unmanaged`-constrained type parameter

The ADR-0122 pointer-pointee gate in `Binder` is widened to admit a pointee that
is a `TypeParameterSymbol { HasUnmanagedConstraint: true }`, alongside the
existing blittable-primitive / blittable-value-struct / pointer pointees. A bare
(unconstrained) type parameter is still rejected with `GS0398`. As with all raw
pointer code (ADR-0122), pointer *dereference* is unverifiable by design;
`ilverify` reports the same inherent `UnmanagedPointer` / `StackByRef` codes for
generic `*T` as for concrete `*int32`.

### 5. CLR mapping (emit)

The `unmanaged` constraint emits exactly what C# emits — verified byte-for-byte
against `csc` output:

- On the `GenericParam` row:
  `GenericParameterAttributes.NotNullableValueTypeConstraint | DefaultConstructorConstraint`
  (the same bits `struct` emits, per ECMA-335 II.10.1.7).
- **Plus** a `GenericParamConstraint` row whose `Constraint` is a `TypeSpec`
  encoding `System.ValueType` decorated with a **required custom modifier**
  (`modreq`) of `System.Runtime.InteropServices.UnmanagedType`. The signature
  blob is:

  ```
  ELEMENT_TYPE_CMOD_REQD <UnmanagedType>  ELEMENT_TYPE_CLASS <System.ValueType>
  ```

  `System.ValueType` is itself an abstract **class**, so it is encoded with
  `ELEMENT_TYPE_CLASS` (0x12) — **not** `ELEMENT_TYPE_VALUETYPE` (0x11).
  Encoding it as a value type makes the CLR loader reject every closed
  instantiation at runtime with a "value type mismatch" `TypeLoadException`,
  even though such an assembly still passes `ilverify`. This subtlety is the
  single most error-prone part of the feature and is covered by an executing
  emit test (not merely a verification test).

`TypeDefEmitter.FlushPendingGenericParameters` emits the extra constraint row
when `PendingGenericParameter.HasUnmanagedConstraint` is set;
`ReflectionMetadataEmitter.BuildUnmanagedConstraintTypeSpec` builds the modreq
blob (written manually with `BlobBuilder`, because the `SignatureTypeEncoder`
from `TypeSpecificationSignature()` does not expose `CustomModifiers()`).

A combined `[T IComparable[T] unmanaged]` emits **both** `GenericParamConstraint`
rows (the `IComparable<T>` generic-instance TypeSpec and the modreq-ValueType
TypeSpec).

## Diagnostics

| ID | When |
| --- | --- |
| GS0415 | The operand of `sizeof(T)` is not an unmanaged type. |
| GS0152 | A type argument does not satisfy an `unmanaged` constraint (reuses the existing constraint-satisfaction code; `DescribeConstraint` prints `"unmanaged"`). |
| GS0398 | A pointer pointee is a type parameter that is **not** `unmanaged`-constrained (unchanged ADR-0122 diagnostic; now narrowed so the `unmanaged` case is allowed). |

## Consequences

- The Oahu `unsafe` generic SIMD helpers (issue #914) compile and emit
  verifiable IL (the `sizeof(T)` portion is fully verifiable; the `*T` portion
  is unverifiable-by-design exactly like concrete pointers).
- `unmanaged` joins `class` / `struct` / `init()` as a first-class flag
  constraint; the metadata is byte-compatible with C#, so a G#-authored
  `where T : unmanaged` generic is consumable from C# and vice versa.
- `sizeof` becomes a contextual keyword in expression position. Existing
  identifiers named `sizeof` outside `sizeof(...)` are unaffected.

### Tests

- `test/Core.Tests/CodeAnalysis/Binding/Issue1336GenericUnmanagedConstraintTests.cs`
  — binder coverage: `sizeof(T)` over `[T unmanaged]` binds; `sizeof(T)` over
  `[T any]` and `sizeof(string)` report GS0415; `sizeof(int32)` binds; `*T` over
  `[T unmanaged]` binds while `*T` over `[T any]` reports GS0398; `unmanaged`
  satisfaction (int32 ok, string → GS0152); combined `[T IComparable[T]
  unmanaged]`.
- `test/Compiler.Tests/Emit/Issue1336GenericUnmanagedSizeOfEmitTests.cs`
  — executing emit coverage: `sizeof(T)` yields the correct per-instantiation
  size (1/4/8) and the `256/8/sizeof(T)` lane count (32/16/8) under `ilverify`
  with no ignored codes; `*T` pointer write-through runs correctly under the
  inherent-unsafety ignored-code set. These tests **execute** the produced
  assembly, which is what catches the `ELEMENT_TYPE_CLASS` vs
  `ELEMENT_TYPE_VALUETYPE` distinction that `ilverify` alone misses.
