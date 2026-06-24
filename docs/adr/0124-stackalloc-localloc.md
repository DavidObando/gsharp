# ADR-0124: `stackalloc T[n]` stack allocation (`localloc`) — safe `Span<T>` and unsafe `T*` forms

- **Status**: Accepted
- **Date**: 2026-06-26
- **Phase**: Phase 9 — low-level / interop depth
- **Related**: ADR-0039 (managed by-ref pointers / address-of / dereference), ADR-0122 (unsafe context and unmanaged raw pointers `*T`), issue [#1024](https://github.com/DavidObando/gsharp/issues/1024)

## Context

ADR-0122 (#1014) introduced the `unsafe` context and the unmanaged raw pointer
type (`*T` = CLR `ELEMENT_TYPE_PTR`). It explicitly deferred `stackalloc`
(issue #1024). Until now G# had no way to stack-allocate a contiguous buffer;
the source `var buf = stackalloc uint8[4]` failed with `GS0125` because
`stackalloc` lexed as a plain identifier.

`stackalloc` allocates a contiguous block of memory on the call stack — emitted
as the CIL `localloc` instruction — that is automatically reclaimed when the
method returns. C# exposes two flavours:

- A **safe** form, `Span<T> s = stackalloc T[n];`, which wraps the `localloc`'d
  block in a `System.Span<T>` and needs **no** `unsafe` context. This is the
  primary, most-useful target: bounds-checked element access, a `.Length`, no
  raw pointers in user code.
- An **unsafe** form, `T* p = stackalloc T[n];`, which yields the raw pointer
  and is only legal inside an `unsafe` context.

## Decision

### 1. Syntax — `stackalloc` as a contextual keyword

`stackalloc` is a **contextual keyword** (no new reserved word). The parser
recognises it only in the exact shape `stackalloc IDENT [` (the keyword, an
element-type identifier, then `[`); in every other position it keeps lexing as
an ordinary identifier, so existing code that happens to use `stackalloc` as a
name is unaffected.

The new `StackAllocExpressionSyntax` node holds the `stackalloc` keyword token,
the element-type identifier, and the bracketed **count** expression. The count
is a full expression (so a runtime length such as `stackalloc int32[n]` works),
not just a literal.

> The initializer form (`stackalloc T[n]{a, b, …}` / `stackalloc T[]{…}`) is
> **deferred** to a follow-up issue; only the count-only form is implemented
> here. Both the safe and unsafe count-only forms are fully implemented.

### 2. Binding — element-type rules and form selection

`BoundStackAllocExpression` carries the element type, the (Int32-converted)
count, the result type, and an `IsPointerForm` flag.

- The element type `T` must be **blittable / unmanaged** — the same
  `TypeSymbol.IsLegalPointeeType` predicate used by ADR-0122's pointer pointee
  rule (blittable primitives and pointers), and it must have a CLR type.
  Otherwise the new **GS0399** (`ReportStackAllocElementTypeNotBlittable`) is
  reported. An undefined element type still reports the pre-existing GS0113.
- The count expression is converted to `int32`.
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

`stackalloc T[n]` lowers to:

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
for the Span length:

- **Pointer form** stops after `localloc`: the native pointer is the value.
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
a freshly-allocated `stackalloc int32[4]` reads back all zeros).

### 5. Verifiability

Code containing `localloc` is **unverifiable by design**: ilverify reports
`Unverifiable` at the `localloc` site (and, for the raw-pointer form, the
ADR-0122 unmanaged-pointer codes `UnmanagedPointer` / `StackUnexpected` /
`StackByRef`). The emit tests pass those specific codes to
`IlVerifier.Verify(..., ignoredErrorCodes)` and assert **runtime** behaviour
instead, so the gate still catches *new* unrelated verification regressions
without weakening ilverify globally. The safe `Span<T>` form is still
unverifiable purely because of the `localloc`; only that one code is ignored
for it.

## Consequences

- The safe form `var buf = stackalloc uint8[4]` compiles, runs, and yields a
  bounds-checked `System.Span<uint8>` with `.Length`, with **no** `unsafe`
  context — the primary deliverable of #1024.
- The unsafe form `var p *int32 = stackalloc int32[3]` yields the raw
  `localloc` pointer inside an `unsafe` context, reusing ADR-0122's
  `PointerTypeSymbol` / `ELEMENT_TYPE_PTR` machinery.
- A new `SyntaxKind.StackAllocExpression` and `BoundNodeKind.StackAllocExpression`
  are added; the coverage matrix (`coverage-matrix.golden.txt`,
  `docs/coverage-matrix.md`) and the `BoundNodeKindExhaustivenessTests`
  allowlists are updated accordingly.
- A new diagnostic **GS0399** flags a non-blittable element type.
- `localloc` IL is unverifiable, as in C#; tests assert runtime behaviour.

## Deferrals (follow-up issues, reference #1024)

- **Stackalloc initializer form** `stackalloc T[n]{a, b, …}` / `stackalloc T[]{…}`.
- **`stackalloc` to user structs / non-blittable pointees** (currently GS0399),
  tracking ADR-0122's analogous pointer-pointee deferral.
