# ADR-0096: P/Invoke `@MarshalAs` parameter custom marshallers

- **Status**: Accepted
- **Date**: 2026-06-13
- **Phase**: Native interop follow-up; closes the "`@MarshalAs` and custom marshallers" deferral noted on ADR-0086 §2, ADR-0092 §2, ADR-0093 §10, ADR-0094 §6, and ADR-0095 §6.
- **Supersedes (partially)**: ADR-0086 §2 — the v1 marshalling table is no longer the only way to override CLR marshalling defaults; the per-parameter `@MarshalAs(UnmanagedType.…)` annotation lets users opt into LPWStr/UTF8Str/SafeArray/etc.
- **Related**: ADR-0086 (`@DllImport` P/Invoke), ADR-0092 (`@LibraryImport` source-generator-shaped P/Invoke), ADR-0093 (struct / class marshalling), ADR-0094 (`ref` / `out` / `in` parameter marshalling), ADR-0095 (function-pointer marshalling), issue #762, parent #706, prior PRs #727 (ADR-0086), #758 (ADR-0092), #759 (ADR-0093), #760 (ADR-0094), #761 (ADR-0095).

## Context

ADR-0086 v1 fixed each parameter's unmanaged form to the CLR default for the parameter's G# type — `string` ⇒ `LPSTR` (per `CharSet`), `bool` ⇒ `BOOL` (4-byte Windows BOOL), `[]T` ⇒ `LPArray`, etc. That covers the bulk of POSIX / Windows API surface but misses several common cases that real interop code needs:

- Unicode entry-points on Windows (`MessageBoxW`, `CreateFileW`, …) want `LPWStr`, not `LPSTR`.
- Modern UTF-8-first C APIs (`libgit2`, `libsodium`, `curl`) want `LPUTF8Str`.
- C APIs that take `int`-sized boolean flags (`int success`) want `I4`, not the 4-byte Windows BOOL.
- `[]T` arrays passed to functions where the length is conveyed by a separate `int count` parameter need `LPArray` with `SizeParamIndex: idxOfCount`.
- `BSTR`-bearing COM APIs need `BStr` so the runtime allocates a `SysAllocString`-managed buffer.
- Inline fixed-size buffers and strings (`char buf[256]`) require `ByValArray` / `ByValTStr` with `SizeConst`.

C# expresses these overrides with `[MarshalAs(UnmanagedType.…)]` on the offending parameter (or field, for struct fields — out of scope for this ADR). G# has had the parser machinery for parameter-level annotations since ADR-0047 (the `param`-target attribute slot), but the binder ignored `@MarshalAs` and the emitter dropped the user's intent on the floor.

Issue #762 (parent #706) closes the gap. The implementation adds:

1. **Binder** validation of `@MarshalAs(UnmanagedType.…)` against the parameter's G# type (compatibility table in §3).
2. **Emit** of a CLR `FieldMarshal` table row keyed off the parameter handle, per ECMA-335 II.23.4, plus `ParameterAttributes.HasFieldMarshal` on the Param row.
3. **Diagnostics** GS0357–GS0360 for unsupported `UnmanagedType` values, type-incompatibility, missing required knobs, and misuse on non-P/Invoke functions.
4. A new sample (`samples/PInvokeMarshalAs.gs`) and a refreshed spec / tour / diagnostics catalogue.

## Decision

### 1. Syntax — `@MarshalAs(UnmanagedType.…)` on P/Invoke parameters

The parser already accepts arbitrary `@Attribute(…)` annotations on parameters per ADR-0047 §3. No grammar change is required. The discriminator is purely the attribute type:

```gs
package P
import System.Runtime.InteropServices

@DllImport("user32", EntryPoint: "MessageBoxW")
func native_message_box(
    hWnd nint,
    @MarshalAs(UnmanagedType.LPWStr) lpText string,
    @MarshalAs(UnmanagedType.LPWStr) lpCaption string,
    uType uint32) int32;

// `int success` is a typical C-style boolean — declare the G# parameter
// as `bool` and tell the runtime to marshal it as a 4-byte int.
@DllImport("libc", EntryPoint: "my_set_flag")
func native_set_flag(@MarshalAs(UnmanagedType.I4) on bool) int32;

// Array sized by a sibling `count` parameter (index 1, zero-based).
@DllImport("libfoo", EntryPoint: "process_buffer")
func native_process_buffer(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int32;
```

The annotation belongs to the parameter declaration; the default annotation target is `param` so no `@param:` prefix is required. The attribute is **pseudo-custom** — its state is encoded into a `FieldMarshal` table row, not a `CustomAttribute` row, so the emitter does not also write it as a CustomAttribute on the Param row (mirrors C#'s behaviour for `[MarshalAs]`).

### 2. Supported `UnmanagedType` values (v1)

The v1 supported set, in the order users are most likely to reach for them:

| `UnmanagedType`           | Byte | Notes                                                                           |
|---------------------------|------|---------------------------------------------------------------------------------|
| `LPStr`                   | 0x14 | ANSI null-terminated string.                                                    |
| `LPWStr`                  | 0x15 | UTF-16 null-terminated string (canonical Windows `…W` entry-point shape).      |
| `LPUTF8Str`               | 0x30 | UTF-8 null-terminated string (modern POSIX / cross-platform C APIs).            |
| `BStr`                    | 0x13 | `SysAllocString`-managed COM string.                                            |
| `LPArray`                 | 0x2a | Pointer-to-element block; sized by `SizeConst` and/or `SizeParamIndex`.        |
| `SafeArray`               | 0x1d | COM `SAFEARRAY`; element variant type via `SafeArraySubType`.                  |
| `I1` / `U1`               | 0x03 / 0x04 | 1-byte signed / unsigned integer. Used to widen `bool` to `int8`/`uint8`. |
| `I2` / `U2`               | 0x05 / 0x06 | 2-byte signed / unsigned integer.                                          |
| `I4` / `U4`               | 0x07 / 0x08 | 4-byte signed / unsigned integer (most common `bool` widening target).     |
| `I8` / `U8`               | 0x09 / 0x0a | 8-byte signed / unsigned integer.                                          |
| `Bool`                    | 0x02 | CLR default — 4-byte Windows `BOOL` (`TRUE`/`FALSE`).                          |
| `VariantBool`             | 0x25 | 2-byte COM `VARIANT_BOOL` (`VARIANT_TRUE`/`VARIANT_FALSE`).                   |
| `SysInt`                  | 0x1f | Native-sized signed integer (`intptr_t`).                                       |
| `SysUInt`                 | 0x20 | Native-sized unsigned integer (`uintptr_t`).                                    |
| `Struct`                  | 0x1b | The default for struct values; included for explicit overrides.                |
| `ByValTStr`               | 0x17 | Fixed-size inline string (`char buf[N]`); requires `SizeConst`.                |
| `ByValArray`              | 0x1e | Fixed-size inline array (`T buf[N]`); requires `SizeConst`.                    |

`UnmanagedType` values outside this set (`CustomMarshaler`, `IUnknown`, `IDispatch`, `FunctionPtr`, `Currency`, `LPStruct`, …) are rejected with **GS0357**. Custom marshallers are filed as a follow-up; FunctionPtr is already covered by ADR-0095's raw `unmanaged[CC] (…) -> R` syntax.

### 3. Type-compatibility rules

The binder enforces a strict compatibility table per `UnmanagedType` value. Mismatches produce **GS0358** ("`@MarshalAs(UnmanagedType.X)` is not valid on parameter '…' of type '…'"). The table:

| `UnmanagedType`                                         | Compatible G# parameter types                                                                 |
|---------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `LPStr`, `LPWStr`, `LPUTF8Str`, `BStr`, `ByValTStr`     | `string`                                                                                      |
| `Bool`, `VariantBool`                                   | `bool`                                                                                        |
| `I1`, `U1`, `I2`, `U2`, `I4`, `U4`, `I8`, `U8`          | `bool`, `char`, and every integer type (`int8`…`int64`, `uint8`…`uint64`, `nint`, `nuint`)   |
| `SysInt`, `SysUInt`                                     | integer types (`int8`…`int64`, `uint8`…`uint64`, `nint`, `nuint`)                            |
| `Struct`                                                | any struct type (`@StructLayout`-annotated per ADR-0093)                                      |
| `LPArray`, `SafeArray`, `ByValArray`                    | slice (`[]T`) of a v1-supported primitive                                                     |

Required-knob checks (**GS0359** when violated):

- `ByValTStr` requires `SizeConst:` (the inline string is exactly N code units).
- `ByValArray` requires `SizeConst:` (the inline array is exactly N elements).
- `LPArray` requires at least one of `SizeConst:` or `SizeParamIndex:` so the runtime knows the element count.

The byref form (`ref T`, `out T`, `in T`) on a parameter validates `@MarshalAs` against the pointee `T`. Combining `@MarshalAs(LPArray, SizeParamIndex: i)` with `ref` is accepted whenever the pointee passes the slice check.

### 4. FieldMarshal blob encoding (ECMA-335 II.23.4)

The emitter writes the encoded blob via `MetadataBuilder.AddMarshallingDescriptor(parameterHandle, blobHandle)` and stamps `ParameterAttributes.HasFieldMarshal` on the Param row. The byte sequences (always anchored at the `UnmanagedType` byte):

| Form                                                                | Encoded bytes                                                               |
|---------------------------------------------------------------------|-----------------------------------------------------------------------------|
| `@MarshalAs(UnmanagedType.X)` for a bare value (X ∉ array/string)   | `[X]`                                                                       |
| `@MarshalAs(UnmanagedType.LPArray)` with `SizeParamIndex: p`        | `[0x2a][0x50][compress(p)]`                                                 |
| `@MarshalAs(UnmanagedType.LPArray)` with `SizeConst: n`             | `[0x2a][0x50][compress(0)][compress(n)]`                                    |
| `@MarshalAs(UnmanagedType.LPArray, SizeParamIndex: p, SizeConst: n)`| `[0x2a][0x50][compress(p)][compress(n)]`                                    |
| `@MarshalAs(UnmanagedType.LPArray, ArraySubType: T, SizeConst: n)`  | `[0x2a][T][compress(0)][compress(n)]`                                       |
| `@MarshalAs(UnmanagedType.ByValArray, SizeConst: n)`                | `[0x1e][compress(n)]`                                                       |
| `@MarshalAs(UnmanagedType.ByValArray, SizeConst: n, ArraySubType: T)`| `[0x1e][compress(n)][T]`                                                   |
| `@MarshalAs(UnmanagedType.ByValTStr, SizeConst: n)`                 | `[0x17][compress(n)]`                                                       |
| `@MarshalAs(UnmanagedType.SafeArray)`                               | `[0x1d]`                                                                    |
| `@MarshalAs(UnmanagedType.SafeArray, SafeArraySubType: V)`          | `[0x1d][compress(V)]`                                                       |

`compress(n)` denotes the ECMA-335 compressed-integer encoding (1–4 bytes depending on magnitude). `0x50` is the CLR-reserved `NATIVE_TYPE_MAX` sentinel meaning "ArraySubType unspecified — use the managed element type to pick the unmanaged form".

### 5. Interaction with sibling P/Invoke ADRs

| ADR        | Interaction with `@MarshalAs`                                                                                                              |
|------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| ADR-0086   | Default marshalling table still applies when no `@MarshalAs` is present. `@MarshalAs` on a `@DllImport` parameter overrides per-parameter.  |
| ADR-0092   | `@MarshalAs` on a `@LibraryImport` non-string parameter is honoured by writing the FieldMarshal row on the outer Param. `@MarshalAs` on a `@LibraryImport` **string** parameter is rejected with **GS0360** — the function-wide `StringMarshalling:` knob is the canonical lever; per-parameter overrides would require generating per-parameter outer-stub code. |
| ADR-0093   | Struct-layout / blittability rules are unchanged. `@MarshalAs(UnmanagedType.Struct)` on a struct-typed parameter is accepted as an explicit no-op override. Per-field `@MarshalAs` on struct fields is out of scope (filed as a future follow-up). |
| ADR-0094   | `@MarshalAs(LPArray, …)` on a `ref []T` parameter is accepted whenever the slice element passes the v1 primitive check. The byref pointee rule (GS0352) is independent of the `@MarshalAs` rule.    |
| ADR-0095   | Function-pointer (`unmanaged[CC] (…) -> R`) and delegate-callback parameters are unaffected: `@MarshalAs(UnmanagedType.FunctionPtr)` would be the C# escape hatch, but G# already has the raw FNPTR syntax, so FunctionPtr is intentionally not in the v1 supported set. |

### 6. Diagnostics

| ID      | Severity | Message                                                                                                                                                                | Anchor location                          |
|---------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------|
| GS0357  | Error    | `'@MarshalAs' UnmanagedType '<value>' is not in the v1 supported set. Use one of: LPStr, LPWStr, LPUTF8Str, BStr, LPArray, SafeArray, I1, U1, I2, U2, I4, U4, I8, U8, Bool, VariantBool, SysInt, SysUInt, Struct, ByValTStr, ByValArray.` | The offending `@MarshalAs(...)` argument |
| GS0358  | Error    | `'@MarshalAs(UnmanagedType.<X>)' is not valid on parameter '<name>' of type '<T>'.`                                                                                    | The offending `@MarshalAs(...)` annotation |
| GS0359  | Error    | `'@MarshalAs(UnmanagedType.<X>)' on parameter '<name>' requires the '<arg>' named argument.`                                                                           | The offending `@MarshalAs(...)` annotation |
| GS0360  | Error    | `'@MarshalAs' on parameter '<name>' is not supported: <reason>.`                                                                                                       | The offending `@MarshalAs(...)` annotation |

**GS0360 reasons (v1):**

- "the enclosing function is not a P/Invoke declaration (`@DllImport` or `@LibraryImport`)" — `@MarshalAs` on a managed function's parameter has no CLR-defined meaning; the runtime never consults the FieldMarshal row for non-P/Invoke methods.
- "`@LibraryImport` string parameters take their encoding from the function-wide `StringMarshalling` knob; use `@LibraryImport(StringMarshalling: StringMarshalling.Utf8)` (or Utf16) instead" — see §5 ADR-0092 row.

## Examples

### LPWStr on `MessageBoxW` (Windows-only)

```gs
package P
import System.Runtime.InteropServices

@DllImport("user32", EntryPoint: "MessageBoxW")
func MessageBoxW(
    hWnd nint,
    @MarshalAs(UnmanagedType.LPWStr) lpText string,
    @MarshalAs(UnmanagedType.LPWStr) lpCaption string,
    uType uint32) int32;
```

### Bool widening for a C function that takes `int`

```gs
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "set_flag")
func native_set_flag(@MarshalAs(UnmanagedType.I4) on bool) int32;
```

### Sized array (LPArray + SizeParamIndex)

```gs
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "sum_buffer")
func native_sum_buffer(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int64;
```

### LPUTF8Str against `strlen` on POSIX

```gs
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "strlen")
func native_strlen(@MarshalAs(UnmanagedType.LPUTF8Str) s string) nuint;
```

## Consequences

### Positive

- G# can now declare any Windows `…W` entry-point, any UTF-8-first C API, and the bulk of "C function with `int` boolean flag" surface without a hand-written C# shim.
- The emitted `FieldMarshal` rows are 100% standard CLR metadata — `ildasm`, ILSpy, and decompilers display the user's intent identically to a hand-written C# `[MarshalAs(UnmanagedType.…)]`.
- `ilverify` continues to pass; the FieldMarshal table is not part of CLR verifiability — it only feeds the runtime marshaller.
- AOT publishing is unaffected: `@DllImport` already relies on the runtime-synthesised stub (which reads FieldMarshal), and the `@LibraryImport` path explicitly elides `@MarshalAs` on string parameters in favour of the explicit `StringMarshalling`-driven outer stub.

### Negative

- The supported set is intentionally narrow (21 `UnmanagedType` values) — `CustomMarshaler`, COM-style `IUnknown`/`IDispatch`, and the rest of the BCL surface remain rejected with GS0357.
- `@MarshalAs` on **struct fields** is out of scope; the implementation only consults parameter-level annotations. A future ADR will reuse the same `MarshalAsMetadata` / FieldMarshal-blob plumbing for `@FieldOffset`-style per-field overrides.
- `@LibraryImport` string parameters cannot use `@MarshalAs` (GS0360) — the per-call `StringMarshalling:` knob is the only lever in v1. Sub-parameter overrides on `@LibraryImport` are filed as a future follow-up.

### Alternatives considered

- **Auto-derive the unmanaged form from a separate G#-level `string?` / `string!` type qualifier.** Rejected — G# does not have a string-encoding type system, and the C# `[MarshalAs]` shape is what every CLR-aware tool already understands.
- **Allow `@MarshalAs` on every G# parameter (not just P/Invoke).** Rejected — the FieldMarshal row is silently ignored for non-P/Invoke methods, which would mask the user's intent. GS0360 makes the misuse explicit.
- **Honour `@MarshalAs` on `@LibraryImport` string parameters by generating a per-parameter outer stub.** Rejected for v1 — the per-call `StringMarshalling:` knob covers the common case; generating per-parameter outer stubs is a multi-feature delta filed as a follow-up.

## References

- ECMA-335 II.23.4 — FieldMarshal blob encoding.
- ECMA-335 II.22.17 — FieldMarshal table row layout.
- ADR-0047 — Kotlin-style annotations (the `param`-target attribute slot).
- ADR-0086 (issue #727) — `@DllImport` P/Invoke.
- ADR-0092 (issue #758) — `@LibraryImport` source-generator-shaped P/Invoke.
- ADR-0093 (issue #759) — struct / class marshalling.
- ADR-0094 (issue #760) — `ref` / `out` / `in` parameter marshalling.
- ADR-0095 (issue #761) — function-pointer marshalling.
- Issue #762 — `@MarshalAs` custom marshallers (this ADR).
- Issue #706 — native-interop parent.
