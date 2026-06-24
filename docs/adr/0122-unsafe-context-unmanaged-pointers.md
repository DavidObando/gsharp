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

Following the cs2gs translator's existing mapping, the opaque byte pointer is
spelled **`*uint8`** (C# `void*`/`byte*` both lower to `*uint8`). A true
distinct `void`-element pointer is **deferred** (follow-up) — `*uint8` covers
the blittable Win32 surface and round-trips through `nint` identically.

### 4. Legal pointee subset

Only **blittable primitives** (`int8…int64`, `uint8…uint64`, `nint`, `nuint`,
`float32`, `float64`, `bool`, `char`) and pointers-to-pointers are legal
pointees. A pointer to a managed reference type or non-blittable type is
rejected with the new **GS0398** diagnostic. Pointers to user structs are
**deferred** (follow-up).

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
- No new node/token kinds, so the coverage matrix and exhaustiveness tests are
  untouched.
- Genuinely-unsafe IL is unverifiable, as in C#; tests assert runtime behaviour.

## Deferrals (follow-up issues, all reference #1014)

- **True `void*`** distinct from `*uint8`.
- **Pointers to user structs / non-blittable pointees** (currently GS0398).
- **Function pointers** (`delegate*`-equivalent) and **fixed-size buffers**.
- **`unsafe func` method signature binding inside a *safe* type** (today only a
  whole `unsafe class`/`unsafe struct`, or a free `unsafe func`/extern, binds
  *signature* param/return types in unsafe context; an `unsafe func` *method*
  in a safe type gets an unsafe *body* only).
- **`stackalloc`** (issue #1024) and **`fixed`** statement / pinning (issue
  #1026) are tracked separately and out of scope here.
