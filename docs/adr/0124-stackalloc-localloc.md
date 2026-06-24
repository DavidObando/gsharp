# ADR-0124: `stackalloc [n]T` stack allocation (`localloc`) — safe `Span<T>` and unsafe `T*` forms, with initializers

- **Status**: Accepted
- **Date**: 2026-06-26
- **Phase**: Phase 9 — low-level / interop depth
- **Related**: ADR-0039 (managed by-ref pointers / address-of / dereference), ADR-0122 (unsafe context and unmanaged raw pointers `*T`), issues [#1024](https://github.com/DavidObando/gsharp/issues/1024), [#1057](https://github.com/DavidObando/gsharp/issues/1057) (G#-style `[n]T` grammar), [#1041](https://github.com/DavidObando/gsharp/issues/1041) (initializer forms)

## Context

ADR-0122 (#1014) introduced the `unsafe` context and the unmanaged raw pointer
type (`*T` = CLR `ELEMENT_TYPE_PTR`). It explicitly deferred `stackalloc`
(issue #1024). Until now G# had no way to stack-allocate a contiguous buffer;
the source `var buf = stackalloc [4]uint8` failed with `GS0125` because
`stackalloc` lexed as a plain identifier.

`stackalloc` allocates a contiguous block of memory on the call stack — emitted
as the CIL `localloc` instruction — that is automatically reclaimed when the
method returns. G# spells it in **G#-style array grammar** `stackalloc [n]T`
(the bracketed count first, then the element type), mirroring G#'s array/slice
type grammar (`[]T` is a slice type, `[n]T` a sized form). C# exposes two
flavours:

- A **safe** form, `var s = stackalloc [n]T`, which wraps the `localloc`'d
  block in a `System.Span<T>` and needs **no** `unsafe` context. This is the
  primary, most-useful target: bounds-checked element access, a `.Length`, no
  raw pointers in user code.
- An **unsafe** form, `var p *T = stackalloc [n]T`, which yields the raw
  pointer and is only legal inside an `unsafe` context.

An optional brace-delimited initializer supplies the element values:
`stackalloc [n]T{a, b, …}` (explicit count) or the count-inferred
`stackalloc []T{a, b, …}` (empty brackets — the length comes from the
initializer).

> **History.** The original implementation (#1024) used C#-style array grammar
> `stackalloc T[n]` and deferred the initializer form. Issue #1057 migrated the
> grammar to G#-style `[n]T` (a breaking change on an unreleased feature, so no
> soft phasing), and issue #1041 added the `[n]T{…}` / `[]T{…}` initializer
> forms. This ADR documents the current `[n]T` grammar.

## Decision

### 1. Syntax — `stackalloc` as a contextual keyword

`stackalloc` is a **contextual keyword** (no new reserved word). The parser
recognises it only in the exact shape `stackalloc [` (the keyword followed by
an open bracket); in every other position it keeps lexing as an ordinary
identifier, so existing code that happens to use `stackalloc` as a name is
unaffected.

The `StackAllocExpressionSyntax` node holds the `stackalloc` keyword token, the
bracketed **count** expression (optional — absent for the count-inferred `[]T`
shape), the element-type identifier, and an optional brace-delimited
**initializer** element list. The count is a full expression (so a runtime
length such as `stackalloc [n]int32` works), not just a literal.

The grammar follows G#'s array/slice type grammar: the count comes first inside
brackets, then the element type. Three shapes are accepted:

- `stackalloc [n]T` — count-only (the buffer is zero-initialised).
- `stackalloc [n]T{a, b, …}` — explicit count with an initializer; the count
  and the initializer length must match (`GS0412` otherwise).
- `stackalloc []T{a, b, …}` — count-inferred; the length comes from the
  initializer. An empty `[]T` without an initializer is rejected (`GS0411`).

### 2. Binding — element-type rules and form selection

`BoundStackAllocExpression` carries the element type, the (Int32-converted)
count, the result type, an `IsPointerForm` flag, and the (element-typed,
conversion-bound) `InitializerElements`.

- The element type `T` must be **blittable / unmanaged** — the same
  `TypeSymbol.IsLegalPointeeType` predicate used by ADR-0122's pointer pointee
  rule (blittable primitives and pointers), and it must have a CLR type.
  Otherwise the new **GS0399** (`ReportStackAllocElementTypeNotBlittable`) is
  reported. An undefined element type still reports the pre-existing GS0113.
- **Count / initializer (issue #1041).** When no initializer is present, the
  count expression is converted to `int32` (a runtime length is allowed). When
  an initializer is present, each element is bound via a conversion to `T`
  (so a non-convertible element reports the standard conversion diagnostic),
  and the effective count is the initializer length:
  - The count-inferred `stackalloc []T{…}` takes its length from the
    initializer; an empty `[]T` without an initializer is rejected with
    **GS0411** (`ReportStackAllocCountInferredWithoutInitializer`).
  - The explicit `stackalloc [n]T{…}` requires `n` to equal the initializer
    length when `n` is a constant, mirroring C# — a mismatch is reported with
    **GS0412** (`ReportStackAllocInitializerLengthMismatch`).
- **Form selection** is driven by the *target type*, exactly as the unsafe
  gating falls out of ADR-0122. When the declared/target type is a
  `PointerTypeSymbol` (which only exists inside an unsafe context — outside
  unsafe, `*T` still means the managed by-ref of ADR-0039), the expression
  binds to the **pointer form** and its type is that `*T`. Otherwise it binds
  to the **safe form** and its type is `System.Span<T>` (a
  `System.ReadOnlySpan<T>` target is likewise honoured via the target-typed
  overload). No additional "unsafe required" diagnostic is needed: the pointer
  form is simply unreachable outside an unsafe context because no
  `PointerTypeSymbol` target exists there.

### 3. Emit — `localloc` + `Span<T>` construction

`stackalloc [n]T` lowers to:

```
<count>            // evaluate the count expression once
stloc   slot       // spill to a pre-allocated int32 scratch local
ldloc   slot
sizeof  T
mul                // byte size = n * sizeof(T)
conv.u
localloc           // -> native pointer to the block
```

`localloc` leaves the pointer on **top** of the stack, but the
`Span<T>(void* pointer, int length)` constructor needs `[ptr, len]`, and CIL
has no `swap`. The count is therefore evaluated once into a pre-allocated
`int32` scratch local (allocated by `MethodBodyPlanner`, keyed by the
stackalloc node) and read back twice — once for the byte-size multiply and once
for the Span length.

**Initializer stores (issue #1041).** When an initializer is present, each
element is stored into the block immediately after `localloc`, through the raw
`localloc` pointer, via the same scaled indirect-store path
(`EmitStoreIndirect` → `stind`/`stobj`) used for pointer/index element writes.
The base pointer is kept on the bottom of the stack across the whole sequence
(no extra scratch local): `dup` copies it for each element, the byte offset
`i * sizeof(T)` is added (`conv.i`), the (already converted) value is pushed,
and `stind`/`stobj` consumes `(addr, value)` leaving the base pointer again.
This is emitted identically for the safe `Span<T>` and unsafe `*T` forms; the
count-inferred `[]T{…}` localloc size is `initializerLength * sizeof(T)`.

- **Pointer form** stops after the (optional) initializer stores: the native
  pointer is the value.
- **Safe form** continues:

  ```
  ldloc   slot              // length
  newobj  Span<T>(void*, int)
  ```

  Encoding the `void*` parameter of that constructor requires a `PTR VOID`
  signature. `ReflectionMetadataEmitter.EncodeClrType` gained a `System.Void`
  case that writes the raw `SignatureTypeCode.Void` byte after the pointer
  prefix; without it the `void*` mis-encoded as a `TypeRef` and the runtime
  threw `MissingMethodException`.

### 4. Zero-initialisation

C# zero-initialises safe-`stackalloc` memory. G# already emits every method
body with `MethodBodyAttributes.InitLocals` (`.locals init`), which makes
`localloc` zero the allocated block. Both forms are therefore zero-initialised
with no extra IL, matching C#'s safe-stackalloc behaviour (verified at runtime:
a freshly-allocated `stackalloc [4]int32` reads back all zeros). When an
initializer is present the elements are written over this zeroed block.

### 5. Verifiability

Code containing `localloc` is **unverifiable by design**: ilverify reports
`Unverifiable` at the `localloc` site (and, for the raw-pointer form — and any
initializer store, which writes through the raw `localloc` pointer — the
ADR-0122 unmanaged-pointer codes `UnmanagedPointer` / `StackUnexpected` /
`StackByRef` / `ExpectedPtr`). The emit tests pass those specific codes to
`IlVerifier.Verify(..., ignoredErrorCodes)` and assert **runtime** behaviour
instead, so the gate still catches *new* unrelated verification regressions
without weakening ilverify globally. A count-only safe `Span<T>` form is still
unverifiable purely because of the `localloc`; only that one code is ignored
for it, while the initializer forms ignore the broader pointer-store set.

## Consequences

- The safe form `var buf = stackalloc [4]uint8` compiles, runs, and yields a
  bounds-checked `System.Span<uint8>` with `.Length`, with **no** `unsafe`
  context — the primary deliverable of #1024.
- The unsafe form `var p *int32 = stackalloc [3]int32` yields the raw
  `localloc` pointer inside an `unsafe` context, reusing ADR-0122's
  `PointerTypeSymbol` / `ELEMENT_TYPE_PTR` machinery.
- The grammar is G#-style `[n]T` (issue #1057) and supports brace-delimited
  initializers `[n]T{…}` / `[]T{…}` (issue #1041), both safe and unsafe.
- A `SyntaxKind.StackAllocExpression` and `BoundNodeKind.StackAllocExpression`
  are used (no new kinds were added for the grammar migration or initializers —
  the existing node was reshaped); the coverage matrix
  (`coverage-matrix.golden.txt`, `docs/coverage-matrix.md`) and the
  `BoundNodeKindExhaustivenessTests` allowlists already list them.
- Diagnostic **GS0399** flags a non-blittable element type; **GS0411** flags a
  count-inferred `[]T` without an initializer; **GS0412** flags an explicit
  `[n]T{…}` whose count disagrees with the initializer length.
- `localloc` IL is unverifiable, as in C#; tests assert runtime behaviour.

## Deferrals (follow-up issues, reference #1024)

- **`stackalloc` to user structs / non-blittable pointees** (currently GS0399),
  tracking ADR-0122's analogous pointer-pointee deferral.
