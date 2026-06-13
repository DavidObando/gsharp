# ADR-0094: P/Invoke `ref` / `out` / `in` parameter marshalling

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Native interop follow-up; closes the "`ref` / `out` / `in` parameter marshalling" deferral noted in ADR-0086 §7 and re-listed on ADR-0092 §6 and ADR-0093 §10.
- **Supersedes (partially)**: ADR-0086 §1 — the "no `ref` / `out` / `in` parameter" function-shape constraint enforced by GS0326 is lifted for P/Invoke; the diagnostic continues to fire for the remaining unsupported shapes (async, generic, instance, extension, `shared`, ref-returning).
- **Related**: ADR-0086 (`@DllImport` P/Invoke), ADR-0092 (`@LibraryImport` source-generator-shaped P/Invoke), ADR-0093 (struct / class marshalling), ADR-0060 (`ref` / `out` / `in` parameters and arguments — language), ADR-0078 (Kotlin-style declaration head), issue #760, parent #706, prior PRs #727 (ADR-0086), #758 (ADR-0092), #759 (ADR-0093).

## Context

ADR-0086 §1 required a P/Invoke function's signature to be free of `ref` / `out` / `in` modifiers. The binder reported **GS0326** ("ref/out/in parameter '<name>' is not supported") on every such parameter and the emitter never had to consider the byref encoding for P/Invoke targets. Issue #728 (later re-filed as #760) tracked the gap.

This constraint forces every realistic POSIX / Windows API that writes a value through a pointer to be wrapped in a hand-written C# shim:

- POSIX `time(time_t *t)`, `clock_gettime(int clock_id, struct timespec *tp)`, `gettimeofday(struct timeval *tv, struct timezone *tz)` — out-pointer is the *only* way the function returns the second result.
- POSIX `pipe(int fds[2])`, `socketpair(int domain, int type, int protocol, int sv[2])` — out-array.
- Windows `QueryPerformanceCounter(LARGE_INTEGER *lpPerformanceCount)`, `GetSystemTimeAsFileTime(FILETIME *)`, almost every "Get" function in the Win32 API.
- Modern allocator-style APIs: `posix_memalign(void **memptr, size_t alignment, size_t size)` (out-pointer-to-pointer), libsodium `crypto_box_keypair(unsigned char *pk, unsigned char *sk)`.
- Any C library that signals success/failure via an `int` return AND writes the actual result through an out-parameter.

The bound-tree and IL infrastructure for byref parameters has been in place since ADR-0060 (#490) — every G# user function already binds `ref`/`out`/`in` parameters, threads them through `ParameterSymbol.RefKind`, lowers ref arguments to `BoundAddressOfExpression`, and encodes them with `isByRef: true` in the method signature blob. The only piece blocking P/Invoke was the binder's blanket rejection at `PInvokeBinder` plus a tightening of the supported-marshalling table for byref pointees.

## Decision

### 1. Surface — `ref` / `out` / `in` accepted on every P/Invoke declaration

Both `@DllImport`-annotated and `@LibraryImport`-annotated functions (`;`-bodied `func` per ADR-0086 / ADR-0092) accept `ref T`, `out T`, and `in T` parameters subject to the pointee-blittability rule in §2. The parser surface is unchanged — ADR-0060's contextual `ref`/`out`/`in` modifier already parses on every parameter site (see Parser.cs around line 2827).

```gs
package P
import System.Runtime.InteropServices

// Primitive out-pointer — libc `time` writes the current epoch time
// through the pointer and also returns it.
@DllImport("libc", EntryPoint: "time")
func native_time(ref t int64) int64;

// Struct out-pointer — `clock_gettime(CLOCK_REALTIME, struct timespec *)`
// fills the pointee with the current wall-clock time. The pointee
// struct must carry `@StructLayout(...)` per ADR-0093 §1 to be
// classified as blittable.
@StructLayout(LayoutKind.Sequential)
struct TimeSpec {
    var tv_sec int64
    var tv_nsec int64
}

@DllImport("libc", EntryPoint: "clock_gettime")
func clock_gettime(clk_id int32, ref tp TimeSpec) int32;

// `out` is the same byref slot semantically; the binder additionally
// enforces ADR-0060 §4 definite-assignment (the caller must not read
// the local before the call).
@DllImport("libc", EntryPoint: "time")
func native_time_out(out t int64) int64;

// `in` is a read-only byref. Marshalled identically to `ref` at the
// unmanaged boundary; the constraint is purely on the managed side
// (the caller may not write through the alias).
@DllImport("libc", EntryPoint: "time")
func native_time_in(in t int64) int64;
```

ADR-0086 §1's other function-shape rejections (`async`, generic, instance method, extension method, `shared` block member, ref-returning function) are unchanged — each still produces GS0326 with its own reason string.

### 2. Pointee blittability

For every P/Invoke parameter whose `ParameterSymbol.RefKind` is `Ref`, `Out`, or `In`, the binder treats the parameter's declared type as the **pointee** of an implicit `T*` and validates it against a strict blittable set:

| Pointee `T`                                | Verdict | Diagnostic                            |
|--------------------------------------------|---------|---------------------------------------|
| `int8` … `int64`, `uint8` … `uint64`       | OK      | —                                     |
| `nint`, `nuint`                            | OK      | —                                     |
| `float32`, `float64`                       | OK      | —                                     |
| Struct annotated with `@StructLayout(LayoutKind.Sequential|Explicit)` whose fields are all blittable (ADR-0093 §2) | OK | — |
| Struct without `@StructLayout`, or with non-blittable fields | Error | GS0349 (existing — "type is not blittable") |
| `bool`, `char`                             | Error   | GS0352 (new)                          |
| `string`                                   | Error   | GS0352 (new)                          |
| `object`, `decimal`, `null`                | Error   | GS0352 (new)                          |
| Slice `[]T`, sequence, array, map, channel | Error   | GS0352 (new)                          |
| Class (regardless of `@StructLayout`)      | Error   | GS0352 (new — class is already passed by reference, not pointer-to-reference) |
| Nullable `T?` (any underlying)             | Error   | GS0352 (new)                          |

The classification rules are deliberately narrower than the by-value rules in ADR-0086 §2 / ADR-0093 §2:

- **`bool` and `char` byref slots are rejected.** A by-value `bool` parameter survives on the existing P/Invoke surface because the runtime marshaller silently translates between CLR `BOOL` (1 byte) and platform `BOOL` (4 bytes on Windows, 1 on POSIX). For a byref slot the runtime cannot transparently insert a width-conversion stub — the caller's managed `bool` lives in a 1-byte slot and the unmanaged callee writes through a `BOOL*` whose width depends on `CharSet` / `MarshalAs`. Accepting it silently would produce inconsistent bit-widths across platforms. The fix is to declare the parameter as `ref uint8` (POSIX) or `ref int32` (Windows) and do the byte ↔ bool widening explicitly in user code.
- **`ref string` is rejected.** Strings need explicit marshalling (a CoTaskMem buffer, freed in a `finally`) and a byref slot would need *two* round-trips — one to allocate before the call, one to read/free after. The remediation is to use `ref nint` and round-trip through `Marshal.PtrToStringUTF8` / `Marshal.StringToCoTaskMemUTF8`.
- **`ref T?` (nullable) is rejected.** Nullable value types are not blittable (the CLR layout is `{ T value; bool hasValue }` with a `Nullable<T>` wrapper; passing the address would expose the `hasValue` byte to the unmanaged side, which has no contract for it).
- **`ref C` for a class `C` is rejected.** ADR-0093 §4 already permits a class parameter to flow as a pointer (`<TypeDef for C>*`) when the class carries `@StructLayout`. Adding a ref-kind on top would produce `<TypeDef for C>**` (pointer to a pointer to managed object) — a shape the runtime marshaller does not understand. The user should drop the ref-kind on a class parameter.

### 3. Diagnostic — GS0352

```
GS0352 (Error): 'ref'/'out'/'in' parameter '<name>' requires a blittable pointee;
'<T>' is not blittable. Use a blittable primitive (e.g. 'int32', 'int64', 'nint'),
or a struct annotated with '@StructLayout(LayoutKind.Sequential)' (ADR-0094).
```

Anchor location: the parameter's type-clause syntax node (so the squiggle lands on `string` in `ref s string`, not on the function identifier).

The struct-blittability path continues to use the existing **GS0349** (ADR-0093 §6) — the remediation is identical to the by-value struct case and reusing the diagnostic keeps the user-facing message single-sourced. **GS0326** is no longer emitted for ref-kind parameters; it remains the umbrella diagnostic for every other unsupported function shape (async, generic, instance, extension, `shared`, ref-return).

### 4. Emit (`System.Reflection.Metadata`)

No new emit code is required. The existing `EmitPInvokeFunction` (ADR-0086) and `EmitLibraryImportFunction` (ADR-0092) already encode each parameter's signature slot with `isByRef: p.RefKind != RefKind.None`:

```csharp
new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
    .Parameters(
        function.Parameters.Length,
        r => EncodeReturnSymbol(r, function.Type, function.ReturnRefKind),
        ps =>
        {
            foreach (var p in function.Parameters)
            {
                EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
            }
        });
```

Lifting the GS0326 rejection in `PInvokeBinder` is sufficient to make `isByRef` evaluate to `true` for ref-kind parameters; the resulting signature blob carries `ELEMENT_TYPE_BYREF` (`0x10`) before the pointee type, and the CLR runtime marshals the parameter as `T*` to the unmanaged callee. The same encoding is applied to both halves of a `@LibraryImport` declaration — the outer managed stub and the inner blittable P/Invoke — so the `ldarg` in the outer body loads the byref slot and the `call` to the inner method passes it straight through. No allocate / free is required in the outer body for byref-blittable parameters (the address is the caller's managed slot and the runtime tracks it as a managed pointer).

### 5. Call-site argument marshalling — already handled by ADR-0060

Calls to a P/Invoke function with ref-kind parameters follow the same call-site shape as ADR-0060 user-function calls:

```gs
var t = 0L
var rc = native_time(ref t)
```

The binder lowers `ref t` to a `BoundAddressOfExpression` wrapping a `BoundVariableExpression`; the emit-time argument loop in `BoundCallExpression` calls `EmitExpression(arg)`, which dispatches on `BoundAddressOfExpression` and emits a `ldloca.s` (or `ldsflda`, `ldflda`, etc. depending on the operand). The address ends up on the eval stack at the moment of `call` to the P/Invoke target. No P/Invoke-specific argument emission is required.

### 6. Interpreter behavior

The interpreter does **not** perform actual native transitions — for any P/Invoke target it runs the empty body the binder reserves (`BoundBlockStatement` with zero statements) and returns the declared return type's default value (consistent with ADR-0086 §7 / ADR-0092 §4 / ADR-0093 §8). The ADR-0060 call-site write-back of ref-kind parameter slots still fires: the interpreter seeds `locals[parameter]` from the caller's lvalue before the call and writes the post-body slot value back to the lvalue after the call. For an empty body the post-body value equals the pre-body value, so the lvalue is unchanged. The interpreter therefore accepts ref-kind P/Invoke declarations and runs them without crashing, but the only way to actually observe native side-effects is the compiler (`gsc`) emit path.

The interpreter test suite covers (a) ref-kind P/Invoke declarations bind without GS0326 / GS0352 diagnostics, (b) `ref` / `out` / `in` parameters with a blittable pointee evaluate to the default return value, and (c) the GS0352 path is reachable from the REPL.

### 7. Interaction with ADR-0086, ADR-0092, ADR-0093

- **ADR-0086** (`@DllImport`): the function-shape rejection at GS0326 narrows — every non-ref-kind shape (async / generic / instance / extension / `shared` / ref-return) still fires GS0326; ref-kind parameters route through the new GS0352 / existing GS0349 instead. The CharSet / SetLastError / CallingConvention knobs are unchanged.
- **ADR-0092** (`@LibraryImport`): the outer / inner stub pair is unchanged. Both halves carry the byref signature. For blittable byref parameters no allocation or free is required — the outer body's `ldarg.s` loads the address and forwards it to the inner P/Invoke as-is. If the signature mixes a byref parameter with a `string` parameter, the string still routes through the existing CoTaskMem allocate / free in the outer wrapper's `try / finally`.
- **ADR-0093** (struct marshalling): `ref T` for a blittable struct `T` is now accepted as a *third* shape alongside by-value `T` and `*T`. The blittability classifier (`BlittableDetector`) is unchanged; the only widening is in `PInvokeBinder`'s parameter-validation loop.
- **ADR-0060** (`ref` / `out` / `in` parameter syntax + binding): no change. The parser already accepts the modifier on every parameter site; the bound-tree shape (`BoundAddressOfExpression` for `ref`/`out`/`in` arguments, `ParameterSymbol.RefKind` for parameters) is reused as-is. The definite-assignment analyzer (`RefKindDefiniteAssignmentAnalyzer`) skips P/Invoke functions because they have an empty body, but the call-site enforcement of `out _ = ...` / `out var x` is unchanged.

### 8. Diagnostic catalogue (new)

| ID      | Severity | Message                                                                                                                                                                                                | Anchor location                                              |
|---------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------|
| GS0352  | Error    | ``'ref'/'out'/'in' parameter '<name>' requires a blittable pointee; '<T>' is not blittable. Use a blittable primitive (e.g. 'int32', 'int64', 'nint'), or a struct annotated with '@StructLayout(LayoutKind.Sequential)' (ADR-0094).`` | The offending parameter type clause.                         |

`GS0349` and `GS0326` continue to apply as before — `GS0349` for non-blittable struct pointees (where the user remediation is "add `@StructLayout` / blittable fields"), `GS0326` for the remaining function-shape rejections (async / generic / instance / extension / `shared` / ref-return). The ADR-0086 §7 / ADR-0092 §6 / ADR-0093 §10 deferral bullets for `ref` / `out` / `in` parameters are now closed.

## Consequences

- Programs can pass managed locals (primitives or blittable structs) to native APIs that write through pointer parameters, removing the last large category of "needs a C# shim" P/Invoke gaps for POSIX time / file / socket / allocator APIs. `time(time_t *)`, `clock_gettime(int, struct timespec *)`, `gettimeofday(struct timeval *, void *)`, `posix_memalign(void **, size_t, size_t)`, and similar surfaces are reachable in pure G#.
- The bound tree gains **no new** `BoundNodeKind` (per the rule of engagement). The bound model already represented ref-kind parameters via `ParameterSymbol.RefKind` and ref-kind arguments via `BoundAddressOfExpression`; the only changes are the binder's narrowed validation (GS0326 → GS0349 / GS0352 routing) and a tighter `IsSupportedMarshallingType` byref pointee classifier.
- The emit pipeline is unchanged. `EmitPInvokeFunction` and `EmitLibraryImportFunction` already encode `isByRef: p.RefKind != RefKind.None`; the resulting metadata signature carries `ELEMENT_TYPE_BYREF` before the pointee type. The runtime marshaller sees a `T*` and passes the caller's managed slot address straight to the unmanaged callee.
- `ilverify` is clean on the emitted assemblies. The ADR-0094 emit tests gate verification through `IlVerifier.Verify` exactly as the ADR-0086 / ADR-0092 / ADR-0093 emit tests do.
- The interpreter accepts ref-kind P/Invoke declarations without crashing and continues to return the declared return type's default value — there is no managed-IL emit pipeline under the interpreter, so the byref slot does not actually round-trip through a native call (consistent with how `@DllImport` / `@LibraryImport` behave today).
- The remaining v1 P/Invoke gaps (issue #761 function pointers, #762 `@MarshalAs` custom marshallers, slices of structs, fixed-size buffers inside marshalled structs) are unchanged.

## Alternatives considered

- **Allow `ref bool` / `ref char` silently.** Rejected — the unmanaged size of `BOOL` and `char` is platform-dependent (`BOOL` is 4 bytes on Windows, 1 on POSIX; `char` is 1 byte on POSIX vs 2 in CLR). Accepting the byref slot without an explicit `@MarshalAs` would mean the user code silently corrupts the unmanaged callee's view of the address (Windows reads 4 bytes; we wrote 1). The fix is to require an explicit `ref uint8` / `ref int32` and an explicit widening step in user code. When `@MarshalAs` lands (#762) we will revisit and allow `ref bool` / `ref char` with the required attribute.
- **Allow `ref string` with implicit CoTaskMem round-trip in a synthetic stub.** Rejected — the round-trip needs *two* boundary crossings (allocate-before, free-after) and the user must know whether the unmanaged callee owns the buffer (it usually does not in C/C++, but every API documents this differently). Encoding a wrong contract silently is worse than rejecting `ref string` outright. The remediation is documented inline in the GS0352 message: use `ref nint` + `Marshal.StringToCoTaskMemUTF8` / `Marshal.PtrToStringUTF8`.
- **Allow `ref T?` (nullable) by passing the address of the underlying `T` slot.** Rejected — the CLR `Nullable<T>` layout is `{ bool hasValue; T value }` (with padding), and the address would include the `hasValue` byte. There is no way to honour the nullable contract across the unmanaged boundary in v1 without a per-parameter wrapper struct. Rejected with GS0352.
- **Disable the GS0326 "no ref/out/in" rejection without tightening the supported-pointee table.** Rejected — the existing `IsSupportedMarshallingType` byref handler accepted *any* primitive including `bool` / `char`, which would silently produce broken IL on cross-platform shapes (see above). The blittability tightening is small and explicit.
- **Add a new `BoundNodeKind` for "P/Invoke call with byref parameters".** Rejected per the BoundTree-discipline rule of engagement and because no new emission shape is needed — the existing `BoundCallExpression` + argument loop already handles `BoundAddressOfExpression` operands, which is exactly how ADR-0060 lowers `ref x` arguments.
- **Synthesize a managed wrapper that pins a fresh local and forwards its address.** Rejected — the runtime marshaller already pins managed slots that participate in P/Invoke for the duration of the call; an extra pin / wrapper would be redundant and would also defeat the `out` semantics (the wrapper would intercept the write).
