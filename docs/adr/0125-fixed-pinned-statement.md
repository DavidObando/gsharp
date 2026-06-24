# ADR-0125: `fixed` statement — pinning a managed buffer and binding an unmanaged `*T`

- **Status**: Accepted
- **Date**: 2026-06-27
- **Phase**: Phase 9 — low-level / interop depth
- **Related**: ADR-0039 (managed by-ref pointers / address-of / dereference), ADR-0056 (ref-returning members / `modreq(InAttribute)` ref-returns), ADR-0122 (unsafe context and unmanaged raw pointers `*T`, issue [#1014](https://github.com/DavidObando/gsharp/issues/1014)), ADR-0124 (`stackalloc`/`localloc`, issue [#1024](https://github.com/DavidObando/gsharp/issues/1024)), issue [#1026](https://github.com/DavidObando/gsharp/issues/1026), issue [#1043](https://github.com/DavidObando/gsharp/issues/1043)

## Context

ADR-0122 (#1014) introduced the `unsafe` context and the unmanaged raw pointer
type (`*T` = CLR `ELEMENT_TYPE_PTR`). ADR-0124 (#1024) added `stackalloc`. Both
explicitly deferred a `fixed`/pinning statement (issue #1026). Until now G# had
no way to obtain a stable raw pointer **into a managed buffer** (array/slice or
string): the GC may relocate such buffers, so a naïvely-taken interior pointer
is unsafe. The repro from #1026 —

```gsharp
package p
func F(dest []uint8) { fixed pD *uint8 = dest { } }
```

— failed with `GS0005` because there was no `fixed` statement grammar.

C# spells this `fixed (T* p = source) { … }`: it pins the managed `source`
(array/string/`GetPinnableReference` span) for the lexical extent of the body
block, emits a CLR **pinned local** (`.locals init ([0] pinned …)`) so the GC
cannot move the buffer, and binds an unmanaged `T*` to the buffer's first
element. On block exit the pin is released.

## Decision

### 1. Syntax — `fixed` as a contextual keyword, paren-less header

The chosen surface syntax is **paren-less**, matching G#'s other statement
headers (`if`/`for`/`while`/`unsafe`) rather than C#'s C-style parentheses:

```gsharp
fixed <name> *T = <source> {
    // body; <name> has type *T and is valid only here
}
```

`fixed` is a **contextual keyword** (no new reserved word / token). The parser
recognises it only in the exact shape `fixed IDENT *` (the keyword, an
identifier, then `*`); in every other position it keeps lexing as an ordinary
identifier, so existing code using `fixed` as a name is unaffected. This
mirrors how `unsafe` and `stackalloc` were added.

The new `FixedStatementSyntax` node holds the `fixed` keyword token, the
pointer identifier, the `*T` type clause, the `=` token, the **source**
expression, and the body block. The source is parsed with **struct-literal
suppression** (the same `suppressStructLiteral` / `suppressTrailingObjectInitializer`
mechanism used by `if`/`for`/`if let` headers) so the `{` that follows the
source opens the **body block**, not a composite literal `Source{…}`.

### 2. Unsafe-context rule — `fixed` is legal only inside `unsafe`

A `fixed` statement produces a raw unmanaged pointer (`*T` = `ELEMENT_TYPE_PTR`),
which is only meaningful inside an `unsafe` context (outside one, `*T` denotes a
managed by-ref). Consistent with ADR-0122's pointer gating, `fixed` is therefore
**legal only inside an existing `unsafe` context** — an `unsafe func`, an
`unsafe { … }` block, or an unsafe type. Used outside one it is rejected with
**`GS0400`**. `fixed` does **not** itself establish an unsafe context; wrap it in
`unsafe { … }` if needed. (This is stricter than, but compatible with, C#, where
`fixed` already requires `/unsafe`.)

### 3. Pin sources — array/slice, string, and span-like (`GetPinnableReference`)

The **source** must be a pinnable managed buffer:

- A slice/array `[]T` — the cs2gs mapping of a C# `T[]`, CLR-backed by the
  single-dimensional zero-based array `T[]` (`SliceTypeSymbol`/`ArrayTypeSymbol`).
  This is the Oahu case `fixed (byte* pD = destination)` where `destination` is
  a `byte[]` ⇒ G# `[]uint8`.
- A `string`.
- A **span-like** source whose type exposes a public instance
  `ref T GetPinnableReference()` — canonically `System.Span[T]` /
  `System.ReadOnlySpan[T]` (issue [#1043](https://github.com/DavidObando/gsharp/issues/1043)).
  The pin yields a `*T` over the span's data, matching C#
  `fixed (T* p = span)`. `ReadOnlySpan[T].GetPinnableReference()` returns
  `ref readonly T` — a `modreq(System.Runtime.InteropServices.InAttribute)`
  ref-return — which the method-reference encoder now reproduces (see §4).

The bound pointer's pointee type must match the buffer's element type;
`uint16`/`char` are accepted interchangeably for `string` (a `string`'s
characters are UTF-16 code units). Any other source — or a pointee/element-type
mismatch — is rejected with **`GS0401`**.

### 4. Lowering — pinned local + element-0 pointer derivation

The binder produces a `BoundFixedStatement` carrying the user-visible pointer
local (`*T`, read-only, scoped to the body) and a **synthetic pinned local**
whose slot type is a `PinnedTypeSymbol(underlying)` marker. The slot planner
allocates both IL slots; `EncodeLocalVariableType` detects `PinnedTypeSymbol`
and sets the local-signature **`pinned`** flag. The emitter mirrors the C#
compiler's codegen exactly:

**Array/slice** (`T[] pinned`):

```
EmitExpr(source); dup; stloc pinned        // pin the array reference
brfalse NULL
ldloc pinned; ldlen; conv.i4; brtrue NOTEMPTY
NULL:     ldc.i4.0; conv.u; stloc ptr       // empty/null ⇒ null pointer
          br AFTER
NOTEMPTY: ldloc pinned; ldc.i4.0; ldelema <elem>; conv.u; stloc ptr
AFTER:    <body>
          ldnull; stloc pinned              // release
```

**String** (`string pinned`):

```
EmitExpr(source); dup; stloc pinned; conv.i
dup; brfalse SKIP
call get_OffsetToStringData; add            // skip the string header
SKIP: conv.u; stloc ptr
<body>
ldnull; stloc pinned                        // release
```

`RuntimeHelpers.OffsetToStringData` is `[Obsolete]`, so the property getter is
resolved reflectively (string literal, not `nameof`) to avoid CS0618. The
classic `OffsetToStringData` lowering is used deliberately instead of
`string.GetPinnableReference()` to avoid the `modreq(InAttribute)` ref-return
signature noted above.

**Span-like / `GetPinnableReference`** (`T& pinned`, issue #1043):

```
EmitExpr(span); stloc src                    // spill the source for addressing
ldloca src; call instance T& GetPinnableReference()
stloc pinned                                 // T& pinned = ref
ldloc pinned; conv.u; stloc ptr
<body>
ldc.i4.0; conv.u; stloc pinned               // release (null the pinned ref)
```

The source value is spilled to a synthetic local so its address can feed the
`GetPinnableReference()` instance call (the `this` of a value-type method is a
managed pointer). `GetPinnableReference()` already returns the data pointer for
an empty span, so — unlike the array form — no null/empty guard is needed. The
pinned local is a managed by-ref (`T& pinned`), released by storing a null
managed pointer (`ldc.i4.0; conv.u`), matching the C# compiler's codegen. The
emitted MemberRef carries the real BCL signature, including
`modreq(System.Runtime.InteropServices.InAttribute)` on
`ReadOnlySpan[T].GetPinnableReference()`'s `ref readonly T` return; the
return-signature encoder reproduces required custom modifiers on by-ref returns
(the same mechanism used for `ref readonly` indexers in ADR-0056), so the call
binds at runtime instead of throwing `MissingMethodException`.

### 5. New node kinds, exhaustiveness, coverage matrix

One new `SyntaxKind.FixedStatement` and one new `BoundNodeKind.FixedStatement`
are added. Both are recorded in `coverage-matrix.golden.txt` and
`docs/coverage-matrix.md`. `BoundNodeKind.FixedStatement` is a **statement**
kind: it gets a real `case` in `MethodBodyEmitter.EmitStatement` and in
`SpillSequenceSpiller.RewriteStatementToList`, and is added to the
`EmitExpressionAllowlist` / `SpillExpressionAllowlist` in
`BoundNodeKindExhaustivenessTests` (statement kinds are not expressions).

## Consequences

- The Oahu pattern `fixed (byte* pD = destination)` is now expressible as
  `fixed pD *uint8 = destination { … }` and compiles + runs.
- Pinning + unmanaged-pointer dereference IL is **unverifiable by design** (as
  in C#); emit tests pass the specific ilverify codes
  (`Unverifiable`, `UnmanagedPointer`, `StackUnexpected`, `StackByRef`,
  `ExpectedPtr`, …) to `ignoredErrorCodes` and assert runtime output, rather
  than disabling ilverify globally.
- Deferred: fixed-size buffers.

## Diagnostics

- **`GS0400`** — a `fixed` statement used outside an `unsafe` context.
- **`GS0401`** — a `fixed` statement source is not a pinnable array/slice or
  string, or the pointer's pointee does not match the buffer's element type.
