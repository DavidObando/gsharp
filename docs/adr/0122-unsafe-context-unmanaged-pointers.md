# ADR-0122: Unsafe context and unmanaged raw pointers (`*T` = `ELEMENT_TYPE_PTR`)

- **Status**: Accepted
- **Date**: 2026-06-24
- **Phase**: Phase 9 — low-level / interop depth
- **Related**: ADR-0039 (managed by-ref pointers / address-of / dereference), ADR-0086 (P/Invoke marshalling), ADR-0094 (by-ref P/Invoke parameters), ADR-0096 (struct marshalling), ADR-0115 (cs2gs migration tool), issue [#1014](https://github.com/DavidObando/gsharp/issues/1014)

## Context

G# already spells a **managed** pointer (CLR `ELEMENT_TYPE_BYREF`, C# `T&`)
with the prefix form `*T` and the unary operators `&x` (address-of) and `*p`
(dereference) — see ADR-0039. A managed by-ref is GC-tracked and is legal only
in tightly-scoped positions: ref-kind parameters (`ref`/`out`/`in`), `ref`
returns, and `let ref` locals. It is deliberately **rejected** as a field type
(GS9006) and as a plain (non-ref-kind) parameter type (GS0243).

Low-level Win32 / native interop needs a genuine **unmanaged** raw pointer
(CLR `ELEMENT_TYPE_PTR`, C# `T*`): a non-GC-tracked address that may be stored
in a field, passed as a plain parameter, cast between pointer types, advanced
with pointer arithmetic, and round-tripped through `nint`/`IntPtr`. The
motivating real-world surface is `Oahu.Foundation`'s `Win32/Win32FileIO.cs`:

```csharp
public unsafe class WinFileIO : IDisposable {
    private void* pBuffer;                      // unsafe pointer FIELD
    byte* pBuf = (byte*)pBuffer;                // pointer LOCAL + cast
    [DllImport("kernel32", SetLastError = true)]
    static extern unsafe bool ReadFile(SafeFileHandle h, void* pBuffer,
        int n, int* pRead, IntPtr o);           // pointer PARAMS
}
```

Before this ADR there was no `unsafe` keyword or context in G# at all, and the
unmanaged-pointer positions were unreachable.

## Decision

### 1. `unsafe` context (contextual keyword)

`unsafe` is introduced as a **contextual keyword** (no new reserved word, no
new `SyntaxKind` token — it is recognised by identifier text in the relevant
parser positions, so existing identifiers named `unsafe` are unaffected
elsewhere). It may appear as:

- an **`unsafe` modifier on a function**: `unsafe func F(...) { ... }` — the
  body, and (for free functions and externs) the signature, bind in an unsafe
  context;
- an **`unsafe { ... }` block statement** inside an otherwise-safe function —
  the block's statements bind in an unsafe context (reuses
  `BlockStatementSyntax` with an `IsUnsafe` flag, no new node kind);
- an **`unsafe` modifier on a type declaration**: `unsafe class C { ... }` /
  `unsafe struct S { ... }` — all members' signatures and bodies bind in an
  unsafe context (this is what enables unsafe pointer **fields**).

Unsafe-ness is tracked by an integer `BinderContext.UnsafeDepth`
(`InUnsafeContext => UnsafeDepth > 0`) that is incremented while binding inside
any of the above and restored on exit (nesting-safe).

### 2. `*T` is overloaded by context: managed by-ref vs unmanaged pointer

The prefix spelling `*T` is **reused** rather than introducing new syntax:

| Context | `*T` means | CLR encoding | Legal as field? | Legal as plain param? |
|---|---|---|---|---|
| **outside** `unsafe` | managed by-ref `T&` | `ELEMENT_TYPE_BYREF` | no (GS9006) | no (GS0243) |
| **inside** `unsafe` | unmanaged pointer `T*` | `ELEMENT_TYPE_PTR` | **yes** | **yes** |

`Binder.BindTypeClause` produces a `PointerTypeSymbol` (new symbol, emits
`ELEMENT_TYPE_PTR` via `SignatureTypeEncoder.Pointer()`) when
`InUnsafeContext`, and the historical `ByRefTypeSymbol` otherwise. The
GS9006 / GS0243 diagnostics test `is ByRefTypeSymbol`, so an unmanaged
`PointerTypeSymbol` passes them naturally — **no diagnostic logic changed**,
and the managed-by-ref behaviour outside unsafe is byte-for-byte unchanged.

`&x` produces an unmanaged pointer (`PointerTypeSymbol`) in an unsafe context
and a managed by-ref (`ByRefTypeSymbol`) otherwise; `*p` dereferences either.

### 3. `void*` spelling

The opaque byte pointer is spelled **`*uint8`** (a dereferenceable 1-byte
pointer). A true, distinct **void-element pointer** is spelled **`*void`**
(issue #1033): a `PointerTypeSymbol` whose pointee is the `void`
`TypeSymbol`, emitting **`ELEMENT_TYPE_PTR` over `ELEMENT_TYPE_VOID`** — the
faithful mapping of C# `void*`.

`*void` is a first-class unmanaged pointer type. It is an explicitly legal
pointer even though `void` is not a blittable pointee
(`Binder.BindTypeClause` special-cases it past the GS0398 blittable-pointee
check). Unlike `*uint8`, a `*void` carries **no element type**, so following
C# `void*` semantics it may **not** be:

- directly dereferenced — `*p` (read) or `*p = v` (write);
- indexed — `p[i]` (read) or `p[i] = v` (write);
- advanced by arithmetic — `p + i`, `p - i`, or `p - q`.

Each of those is rejected with the new **GS0403** diagnostic, which directs
the user to first cast to a typed pointer `*T`. What **is** allowed:

- **casts** to/from typed pointers — `*int32(vp)` (to `*int32`) and
  `*void(p)` (from any `*T`); the latter is the deref-of-conversion-call form
  cs2gs emits for a C# `(void*)p`, recognised syntactically in
  `BindDereferenceExpression` because `void(p)` cannot bind as a value
  conversion;
- **round-trip** through `nint`/`IntPtr` — `nint(vp)` and `*void(addr)`;
- **comparison / equality** — `==`, `!=`, `<`, … (compared as `nint`),
  matching C# (only deref/index/arithmetic need a typed-pointer cast).

The cs2gs translator maps C# `void*` to `*void` (and keeps `byte*`/`sbyte*`
→ their element pointers `*uint8`/`*int8`).

### 4. Legal pointee subset

Legal pointees are **blittable primitives** (`int8…int64`, `uint8…uint64`,
`nint`, `nuint`, `float32`, `float64`, `bool`, `char`), pointers-to-pointers,
and — since issue #1034 — **pointers to blittable user/value structs** (`*S`).
A struct pointee is legal iff `S` is a value type (not a class) and every field
is itself blittable (reusing `BlittableDetector`, mirroring C#'s "unmanaged
type" rule). A pointer to a managed reference type, a non-blittable struct (one
that contains a string / class / other managed field), or a formatted class is
rejected with the **GS0398** diagnostic.

A blittable struct pointer `*S` (issue #1034) is a first-class typed pointer:

- legal as a field, local, plain parameter, and P/Invoke parameter/return
  (marshalled as a native pointer — `ELEMENT_TYPE_PTR` over the struct's
  TypeDef/TypeRef);
- dereferenceable (`*p` read/write) and indexable (`p[i]` read/write), emitted
  as `ldobj`/`stobj <S>` (the typed-indirect-load path, extended from the
  primitive `ldind`/`stind` forms to the struct's type token);
- advanceable by arithmetic (`p + i`, `p - i`) and differenceable (`p - q`,
  issue #1032), **scaled by `sizeof(S)`** — because a user struct's size is not
  known at G# compile time, the scale is emitted as the CIL `sizeof S` opcode
  (a new `BoundSizeOfExpression` lowered node) rather than a compile-time
  constant;
- member-accessible through the pointer in both the explicit `(*p).field` form
  and the arrow sugar **`p->field`** (read and write, plus `p->method(...)` for
  reachable instance methods). `p->member` is parsed as sugar for
  `(*p).member` (no new bound-node kinds). The arrow reuses the existing
  `RightArrowToken`; because G# also spells single-identifier lambdas with
  `->` (`x -> body`), a bare `p->member` is disambiguated to pointer member
  access **only inside an unsafe context** (the parser tracks an unsafe-nesting
  depth). A single-identifier lambda inside unsafe code is still expressible
  via the parenthesised form `(x) -> body`;
- round-trippable through `nint`/`IntPtr` and castable to/from a typed pointer
  via the `*S(expr)` form (the struct analogue of `*uint8(p)` / `*void(p)`).


### 5. Operations (unsafe context only)

All pointer operations are **lowered in the binder** to existing bound nodes +
native-int (`nint`) arithmetic and reinterpret conversions, so **no new
`BoundNodeKind` / `SyntaxKind` / `BoundBinaryOperatorKind`** were added
(avoiding coverage-matrix / exhaustiveness churn):

- **address-of** `&lvalue` → `*T` (`BoundAddressOfExpression(unmanaged: true)`);
- **dereference** `*p` read/write → `BoundDereferenceExpression` /
  `BoundIndirectAssignmentExpression` (`ldind.*` / `stind.*`, identical to the
  by-ref path);
- **indexing** `p[i]` read/write → `*(p + i)`;
- **arithmetic** `p + i` / `p - i` → `*T((nint)p ± (nint)i * sizeof(T))`
  (scaled by the static pointee size);
- **difference** `p - q` (both the same `*T`) → `((nint)p - (nint)q) / sizeof(T)`
  as `nint`, the scaled element count (issue #1032; mismatched `*T - *U`
  remains an error);
- **comparison / equality** `==` `!=` `<` `<=` `>` `>=` → compare as `nint`;
- **null** `nil` → a null pointer (`ldc.i4.0; conv.i`).

### 6. Casts / conversions

`Conversion.Classify` adds **explicit** conversions pointer↔pointer,
pointer↔`nint`/`nuint`/integer, and pointer↔blittable-primitive (the last so a
conversion-call `uint8(p)` binds, enabling the cs2gs `*uint8(p)` ≡ `(byte*)p`
cast form), plus an **implicit** `nil → *T`. Pointer↔pointer and pointer↔`nint`
emit as no-ops (both are native-int-sized); `nil → *T` emits `ldc.i4.0; conv.i`.
This yields the `IntPtr.ToPointer()` / `(void*)someNint` / `(nint)somePtr`
round-trip required by the Win32 surface. (Because `PointerTypeSymbol` only
exists inside an unsafe context, these conversions are effectively
unsafe-gated.)

### 7. P/Invoke

`PInvokeBinder.IsSupportedMarshallingType` accepts a plain `*T`
(`PointerTypeSymbol`) parameter/return whose pointee is a blittable primitive
(or another pointer), marshalled as a native pointer. This is the plain-`*T`
extern-parameter path (`void* pBuffer`, `int* pRead`) complementing the
existing ref-kind by-ref marshalling of ADR-0094.

### 8. Verifiability

Genuinely-unsafe pointer code is **unverifiable by design**: ilverify reports
`UnmanagedPointer`, `StackUnexpected`, and `StackByRef` for raw pointer
manipulation and address-of of array elements. The emit tests pass those
specific codes to `IlVerifier.Verify(..., ignoredErrorCodes)` and assert
**runtime** behaviour instead, so the gate still catches *new* unrelated
verification regressions without weakening ilverify globally.

## Consequences

- Win32-style interop (`WinFileIO`) compiles and runs: pointer fields, plain
  pointer params, deref, indexing, arithmetic, `(byte*)`/`(void*)` casts, and
  `nint` round-trips all work inside an unsafe context.
- The managed by-ref `*T` semantics outside unsafe are **completely unchanged**.
- One new `BoundNodeKind` (`SizeOfExpression`) was added for the struct-pointer
  `sizeof S` scale (issue #1034); the coverage matrix and exhaustiveness
  allowlists are updated accordingly. No new `SyntaxKind` / token was added —
  the `p->field` arrow reuses the existing `RightArrowToken`.
- Genuinely-unsafe IL is unverifiable, as in C#; tests assert runtime behaviour.

## Deferrals (follow-up issues, all reference #1014)

- **True `void*`** distinct from `*uint8` — **implemented** (issue #1033):
  spelled `*void`, emits `ELEMENT_TYPE_PTR ELEMENT_TYPE_VOID`, rejects
  deref/index/arithmetic (GS0403), and round-trips through `nint` / casts
  to/from typed pointers.
- **Pointers to blittable user structs** (`*S`) — **implemented** (issue
  #1034): legal field/local/param/P-Invoke pointee, deref/index via
  `ldobj`/`stobj <S>`, arithmetic and difference scaled by the emitted
  `sizeof S`, and member access through both `(*p).field` and the `p->field`
  arrow sugar. Non-blittable structs (managed/reference fields) are still
  rejected with **GS0398**.
- **Function pointers** (`delegate*`-equivalent) and **fixed-size buffers**.
- **`unsafe func` method signature binding inside a *safe* type** (today only a
  whole `unsafe class`/`unsafe struct`, or a free `unsafe func`/extern, binds
  *signature* param/return types in unsafe context; an `unsafe func` *method*
  in a safe type gets an unsafe *body* only).
- **`stackalloc`** (issue #1024) and **`fixed`** statement / pinning (issue
  #1026) are tracked separately and out of scope here.
