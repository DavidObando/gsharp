# ADR-0125: `fixed` statement — pinning a managed buffer and binding an unmanaged `*T`

- **Status**: Accepted
- **Date**: 2026-06-27
- **Phase**: Phase 9 — low-level / interop depth
- **Amended**: 2026-09-23 — a fixed-size buffer field (ADR-0122 §10) is now a pin source, with C#'s movable/fixed-variable rules; closes the "Deferred: fixed-size buffers" item. See [Amendment 2026-09-23](#amendment-2026-09-23-fixed-size-buffer-pin-source-4378).
- **Related**: ADR-0039 (managed by-ref pointers / address-of / dereference), ADR-0056 (ref-returning members / `modreq(InAttribute)` ref-returns), ADR-0122 (unsafe context and unmanaged raw pointers `*T`, issue [#1014](https://github.com/DavidObando/gsharp/issues/1014)), ADR-0124 (`stackalloc`/`localloc`, issue [#1024](https://github.com/DavidObando/gsharp/issues/1024)), ADR-0153 (interpreter compiled-only storage boundary), issue [#1026](https://github.com/DavidObando/gsharp/issues/1026), issue [#1043](https://github.com/DavidObando/gsharp/issues/1043), issue [#2900](https://github.com/DavidObando/gsharp/issues/2900), issue [#4378](https://github.com/DavidObando/gsharp/issues/4378)

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
- A **fixed-size buffer field** (ADR-0122 §10) reached through a movable
  variable — added by the [2026-09-23 amendment](#amendment-2026-09-23-fixed-size-buffer-pin-source-4378).

The bound pointer's pointee type must match the buffer's element type;
`uint16`/`char` are accepted interchangeably for `string` (a `string`'s
characters are UTF-16 code units). Any other source — or a pointee/element-type
mismatch — is rejected with **`GS0401`**.

### 4. Lowering — pinned local + element-0 pointer derivation

The binder produces a `BoundFixedStatement` carrying the user-visible pointer
local (`*T`, read-only, scoped to the body) and a **synthetic pinned local**
whose slot type is a `PinnedTypeSymbol(underlying)` marker. The slot planner
allocates both IL slots; `EncodeLocalVariableType` detects `PinnedTypeSymbol`
and sets the local-signature **`pinned`** flag. The emitter follows the C#
compiler's protected-cleanup shape.

The pin prologue runs before a protected body. The body is a CLR
`try` region and the release is its `finally` handler, so normal fallthrough,
`break`, `continue`, `goto`, `return`, and exceptions all clear the pinned
local before control reaches an external target. Region-crossing branches emit
`leave`; value returns first store their result in an emitter-planned local and
then `leave` to a `ret` outside the protected region.

For each source kind:

**Array/slice** (`T[] pinned`):

```
EmitExpr(source); dup; stloc pinned        // pin the array reference
brfalse NULL
ldloc pinned; ldlen; conv.i4; brtrue NOTEMPTY
NULL:     ldc.i4.0; conv.u; stloc ptr       // empty/null ⇒ null pointer
          br AFTER
NOTEMPTY: ldloc pinned; ldc.i4.0; ldelema <elem>
          call void* Unsafe.AsPointer<elem>(ref elem); stloc ptr
AFTER:    <body>
          leave DONE
FINALLY:  ldnull; stloc pinned              // release on every exit
          endfinally
DONE:
```

**String** (`string pinned`):

```
EmitExpr(source); dup; stloc pinned; brfalse NULL
ldloc pinned; call char& string.GetPinnableReference()
call void* Unsafe.AsPointer<char>(ref char); stloc ptr
br AFTER
NULL: ldc.i4.0; conv.u; stloc ptr
AFTER:
try { <body> } finally {
    ldnull; stloc pinned                     // release on every exit
}
```

`string.GetPinnableReference()` returns `ref readonly char`; the MemberRef
retains its `modreq(InAttribute)` return signature. `Unsafe.AsPointer<T>`
converts that managed pointer to the numeric native pointer stored in the
user-visible `*T` local.

**Span-like / `GetPinnableReference`** (`T& pinned`, issue #1043):

```
EmitExpr(span); stloc src                    // spill the source for addressing
ldloca src; call instance T& GetPinnableReference()
stloc pinned                                 // T& pinned = ref
ldloc pinned; call void* Unsafe.AsPointer<T>(ref T); stloc ptr
try { <body> } finally {
    ldc.i4.0; conv.u; stloc pinned            // release on every exit
}
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

The `Unsafe.AsPointer<T>` call is deliberate for every managed-pointer source.
Emitting `conv.u` directly after `ldelema` or a ref-return leaves a managed
pointer at an instruction that requires a numeric stack value, producing
ilverify's `ExpectedNumericType` error even though RyuJIT accepts the method.

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
- `await` and `yield` are rejected inside a `fixed` body with **`GS0506`**.
  A state-machine suspension cannot preserve a pinned local. Suspension inside
  a nested lambda remains legal because that lambda has its own function body;
  normal fixed-pointer escape rules still prevent capturing the pointer.
- `fixed` was compiled-only under
  [ADR-0153](0153-interpreter-compiled-only-storage-boundary.md). The deprecated
  `gsi --engine evaluator` path reported that pinning required the CIL
  pinned-local emit path; it did not attempt to emulate pinning without a
  storage and address model. Every default driver executed the emitted
  pinned-local path. ADR-0156 Phase 3c removed the evaluator.
- ~~Deferred: fixed-size buffers.~~ Resolved by the
  [2026-09-23 amendment](#amendment-2026-09-23-fixed-size-buffer-pin-source-4378).

## Diagnostics

- **`GS0400`** — a `fixed` statement used outside an `unsafe` context.
- **`GS0401`** — a `fixed` statement source is not a pinnable array/slice or
  string, or the pointer's pointee does not match the buffer's element type.
- **`GS0506`** — `await` or `yield` appears directly inside a `fixed` body.
- **`GS0507`** — a `fixed` statement pins a fixed-size buffer reached through an
  already-fixed variable (C# CS0213); see the 2026-09-23 amendment.

## Amendment 2026-09-23: fixed-size buffer pin source (#4378)

**Decision (repo owner): C# parity.** A `fixed` statement accepts a fixed-size
buffer field (ADR-0122 §10, `fixed Name [32]int8`) directly as its source,
binds the pointer to the buffer's first element, and keeps the buffer's
containing storage pinned for the whole block — exactly what C#'s
`fixed (sbyte* p = Name) { … }` does. This closes the "Deferred: fixed-size
buffers" item above. The alternative of lowering the C# pattern in cs2gs to a
plain pointer local (`let p *T = buf`) was rejected: it drops the GC pin
whenever the struct lives inside a heap object, which is a real semantic
difference from the C# source.

```gsharp
unsafe struct BoneInfo {
    fixed Name [32]int8
    var Parent int32

    func First() int8 {
        fixed p *int8 = Name {      // bare name: receiver is `this`
            return p[0]
        }
    }
}

unsafe func label(h Holder) {
    fixed p *int8 = h.Bone.Name {   // buffer inside a class instance
        …
    }
}
```

**Recognising the source.** Every reference to a fixed-size buffer field
decays to a `*T` (ADR-0122 §10), so the binder recognises the decay's bound
shape — a pointer reinterpret of the unmanaged address of the buffer field
access — and recovers the field access from it. No other source construct
produces that shape (source code cannot address an undecayed buffer field), so
the recognition cannot capture an arbitrary raw pointer: pinning a plain `*T`
remains `GS0401`. A new `FixedPinKind.FixedBuffer` is added; no new bound-node
kind, so the coverage matrix is unchanged.

**Accept/reject rules — C#'s movable/fixed variable classification** (C# spec
§23.4). The buffer is pinnable when its receiver is *movable*:

| Receiver of the buffer | C# | G# |
|---|---|---|
| struct method receiver `this` (bare `Name` or `this.Name`) | accepted | accepted |
| `ref` / `out` / `in` parameter, ref local | accepted | accepted |
| field of a class instance (`h.B.Name`) | accepted | accepted |
| buffer declared directly on a class (`c.Data`) | n/a (CS1642) | accepted |
| array / slice element (`bones[i].Name`) | accepted | accepted |
| static field | accepted | accepted |
| by-value local or parameter (`b.Name`), incl. nested struct fields | CS0213 | **GS0507** |
| pointer dereference (`p->Name`, `(*p).Name`) | CS0213 | **GS0507** |
| value that is not a variable (`make().Name`) | CS1708 | GS0401 |
| pointee mismatch (`*uint8` over an `int8` buffer) | CS0266 | GS0401 |

Anything the classifier does not recognise is treated as movable: an extra pin
is sound, whereas wrongly rejecting a movable variable would leave no way to
pin it. A local captured by a lambda is classified as a local (fixed), as C#
does — C# also reports CS0213 there — even though G# hoists it into a closure
object; such a buffer can still be addressed through its decayed `*T`.

Two C# rules are **deliberately not ported**:

- **CS1666** ("fixed size buffers contained in unfixed expressions") rejects
  *taking the pointer value* of a movable buffer outside `fixed`
  (`sbyte* q = this.Name;`), while still allowing indexing (`Name[i]`) since
  C# 7.3. G#'s pre-existing decay makes both forms bind through the same
  `*T`, and adopting CS1666 would reject G# code accepted today; it is left as a
  possible follow-up rather than folded into this change.
- **`void*` targets.** C# accepts `fixed (void* p = Name)` through the implicit
  `T* → void*` conversion. The G# `fixed` statement keeps its existing rule
  that the pointee must equal the buffer's element type for every source kind.

**Lowering.** The binder rewrites the source to the managed reference
`ref recv.Name.FixedElementField` (the backing struct's single element field
sits at offset 0). The emitter addresses the buffer field exactly as the decay
does, then steps to the element field, and stores the reference into a
`T& pinned` local — byte-for-byte the IL csc emits:

```
<address of recv>                       // ldarg.0 / ldflda chain / ldelema …
ldflda  valuetype S/'<Name>e__FixedBuffer' S::Name
ldflda  T S/'<Name>e__FixedBuffer'::FixedElementField
stloc   pinned                          // T& pinned
ldloc   pinned
call    void* Unsafe.AsPointer<T>(ref T); stloc ptr
try { <body> } finally {
    ldc.i4.0; conv.u; stloc pinned      // release on every exit
}
```

A buffer is never null or empty, so no guard is needed. As for the other
by-ref pin forms, `Unsafe.AsPointer<T>` replaces csc's `conv.u` (§4), and the
release sits in the protected-cleanup `finally` rather than csc's straight-line
store.

**Bare-name decay (issue #4377).** A bare (implicit-`this`) reference to a
buffer field inside the declaring struct now decays exactly like `this.Name`
on both the read and the indexed-write paths, so `Name[i]`, `Name[i] = v`, and
`fixed p *T = Name { … }` all bind. cs2gs still emits an explicit `this.`
qualifier (issue #4371); both spellings are equivalent.

**cs2gs.** `fixed (T* p = buf) { … }` over a C# fixed-size buffer translates to
`fixed p *T = <buf> { … }`, replacing the interim Unsupported translation gap
report from issue #4371. C# already rejects the fixed-variable cases, so every
translated pin lands in the accepted rows above.

**Diagnostics.** New **`GS0507`** (C# CS0213). **`GS0401`**'s description now
lists the fixed-size buffer source.

