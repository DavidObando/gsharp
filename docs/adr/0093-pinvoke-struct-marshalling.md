# ADR-0093: P/Invoke struct and class marshalling

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Native interop follow-up; closes the "struct / class marshalling" deferral noted in ADR-0086 §7.
- **Supersedes (partially)**: ADR-0086 §2 (struct types listed as "not yet supported" in v1 — every blittable struct is now supported).
- **Related**: ADR-0086 (`@DllImport` P/Invoke), ADR-0092 (`@LibraryImport` source-generator-shaped P/Invoke), ADR-0047 (Kotlin-style annotations), ADR-0027 (bespoke `System.Reflection.Metadata` emitter), issue #759, parent #706, sibling P/Invoke follow-ups #760 (`ref` / `out` primitive parameters), #761 (function-pointer marshalling), #762 (`@MarshalAs` custom marshallers), prior PR #727 (ADR-0086) and PR #758 (ADR-0092).

## Context

ADR-0086 §2 listed the v1 supported P/Invoke marshalling set as primitives (`bool`, `char`, the sized integers and floats), `nint` / `nuint`, `string`, `*T` for primitive `T`, and slices of primitives. Struct and class types were explicitly excluded — the "Not yet supported in v1" bullet pointed at this issue (#759, formerly #730) as the follow-up.

Without struct marshalling, every realistic native API surface that does **not** flatten into a long primitive parameter list is unreachable from G# without a hand-written C# shim:

- POSIX `gettimeofday(struct timeval *tv, struct timezone *tz)` — pre-`clock_gettime` time queries.
- POSIX `clock_gettime(int clock_id, struct timespec *tp)` — high-resolution time queries; the parameter shape is the canonical "blittable struct out-param" pattern.
- Windows `GetSystemTimeAsFileTime(FILETIME*)`, `QueryPerformanceCounter(LARGE_INTEGER*)`, and the entire `BY_HANDLE_FILE_INFORMATION` / `WIN32_FIND_DATA` surface.
- Game / graphics APIs (vectors, matrices, vertex layouts), audio APIs (`PaStreamParameters`), networking APIs (`sockaddr_in`, `iovec`).
- Any C library that defines a "context" or "options" struct passed by pointer.

ADR-0086 already shipped enough metadata-encoding infrastructure to make this addition mechanical at the bound-tree and emit level (the existing `@-attribute` machinery handles the syntax; the bound `FunctionSymbol.PInvokeMetadata` decides whether to emit a single `ImplMap` row or the `@LibraryImport` two-layer stub). The missing pieces are:

1. **Layout-attribute recognition** on struct / class declarations: the binder must read `@StructLayout(LayoutKind.…)`, `@FieldOffset(N)` annotations, and write the resolved layout onto the symbol so the emitter can pick the right CLR `TypeAttributes` flag and `AddTypeLayout` / `AddFieldLayout` rows.
2. **Blittable detection**: the binder must reject non-blittable struct types in P/Invoke signatures with a helpful diagnostic so users don't get an `MarshalDirectiveException` at run-time.
3. **Marshalling table extension** in `PInvokeBinder.IsSupportedMarshallingType` so a blittable struct (and a `*StructName` pointer to one) is accepted, alongside the existing primitives / strings / slices.
4. **Class-marshalling policy** — the CLR allows classes to be marshalled by reference (the runtime pins the object and passes its address), but the semantics are subtle (no return-value classes; the runtime cannot meaningfully marshal a non-blittable class field-by-field without per-field `[MarshalAs]`). v1 picks the conservative subset.

## Decision

### 1. Syntax — `@StructLayout(...)` on the type, `@FieldOffset(N)` on the field

A struct or class declaration may carry an `@StructLayout(LayoutKind.…)` annotation. The annotation's positional argument is a `LayoutKind` enum member; named arguments `Pack` and `Size` thread through to the emitted `ClassLayout` row.

```gs
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X: int32
    var Y: int32
}

@StructLayout(LayoutKind.Explicit, Size: 16)
struct LargeIntegerUnion {
    @FieldOffset(0) var LowPart: uint32
    @FieldOffset(4) var HighPart: int32
    @FieldOffset(0) var QuadPart: int64
}
```

The supported `LayoutKind` values are **`Sequential`** and **`Explicit`** only. `LayoutKind.Auto` is rejected with **GS0346** because Auto-layout types are not portable across P/Invoke (the CLR is permitted to reorder fields, so any consuming C/C++ definition becomes ABI-fragile).

When `@StructLayout` is **absent**, the default is:

- `struct` → `LayoutKind.Sequential` (matches the existing emit and the C# default for value types).
- `class` → `LayoutKind.Auto` (matches the C# default for reference types). A class with no explicit `@StructLayout` is therefore **not** P/Invoke-compatible by default; the binder reports **GS0349** if such a class appears in a P/Invoke signature.

A `@StructLayout` annotation **may** be applied to a `class` declaration; doing so produces a CLR class TypeDef whose layout flag matches the requested `LayoutKind`. The class is still a reference type — see §4 below for class-marshalling policy.

`@FieldOffset(N)` is recognised on fields and:

- **must** appear on **every** field of an `Explicit`-layout type — fields missing a `@FieldOffset` are reported as **GS0347**.
- **must not** appear on any field of a non-`Explicit`-layout type (i.e. an absent `@StructLayout` defaulting to Sequential, or an explicit `@StructLayout(LayoutKind.Sequential)`) — extraneous `@FieldOffset` is reported as **GS0348**.
- The integer argument is required to be a non-negative `int32` literal; a negative or non-integer argument is reported as **GS0350**.

Per ADR-0078, the field declaration head is unchanged: `@FieldOffset(0) var X: int32` parses as a normal field declaration with one attached annotation.

### 2. Blittable detection rules

A G# struct `S` is **blittable** iff **every** instance field of `S` has a type that is:

1. a primitive integer (`int8` / `uint8` / `int16` / `uint16` / `int32` / `uint32` / `int64` / `uint64`),
2. a primitive floating-point (`float32` / `float64`),
3. a native-int primitive (`nint` / `nuint`),
4. an unmanaged pointer `*T` for any `T` (the pointer is blittable regardless of its pointee),
5. another **blittable** G# struct (the relation is recursively defined; user types form a directed acyclic graph because `struct` cannot self-reference without indirection),
6. an imported CLR struct whose runtime `Type` reports `Marshal.SizeOf` without throwing (i.e. the BCL already classifies it as blittable — `Int32`, `Double`, `IntPtr`, `Guid`, etc.).

Anything else makes the struct **non-blittable**. In particular, the following make `S` non-blittable in v1:

- A `bool` field (CLR `BOOL` is 4 bytes on Windows, 1 byte on POSIX; the marshaller injects a per-call conversion).
- A `char` field (CLR `char` is 2 bytes; the C `char` is 1 byte — marshalling requires `[MarshalAs(UnmanagedType.U1)]` per field).
- A `string` field (CLR `string` is a managed reference, not a fixed-size buffer).
- A slice (`[]T`) field, a sequence, an array, a map, a tuple, a channel, a delegate, a class reference (regardless of layout), an interface reference, or any other managed reference type.
- A field whose type itself is non-blittable.

The recursion is performed by `BlittableDetector.IsBlittable(StructSymbol)` (cached per symbol). Cycles cannot occur for value types (the bound-tree builder already rejects recursive struct field types as a separate constraint).

This is a deliberately **conservative** definition: it matches the subset of C#'s blittability rules that does not require synthesizing per-field `MarshalAs` data. Once `@MarshalAs` is supported (issue #762), the definition will be extended to cover fields with explicit `MarshalAs` directives.

### 3. Marshalling-table extension (ADR-0086 §2)

The `PInvokeBinder.IsSupportedMarshallingType` set gains two new rows:

| G# type                          | CLR signature                          | Marshalling default                                |
|----------------------------------|----------------------------------------|----------------------------------------------------|
| Blittable user `struct S`        | `<TypeDef for S>` (value type)         | Passed by value; no marshalling stub needed.       |
| `*S` where `S` is a blittable struct | `<TypeDef for S>*` (unmanaged pointer) | Raw pointer; not GC-tracked.                       |

Existing rows (primitives, `string`, `*T` for primitive `T`, slices of primitives) are unchanged. Slices of structs **remain unsupported** in v1 (they would require an LPArray marshaller that handles per-element field marshalling); the binder reports the existing GS0323 for them.

A non-blittable G# struct in a P/Invoke parameter / return type is reported as **GS0349** rather than the generic GS0323; the tailored message names blittability so the user knows what to fix.

### 4. Class marshalling — by-reference only

Class types are recognized in P/Invoke signatures but with strict limits:

- A G# class can appear as a P/Invoke **parameter type** only if it carries an explicit `@StructLayout(LayoutKind.Sequential)` or `@StructLayout(LayoutKind.Explicit)` annotation **and** every field is blittable per §2.
- A G# class **cannot** appear as a P/Invoke **return type**. The CLR allows it (the runtime allocates a new managed instance), but the ownership semantics differ from any G# value-creation convention — return values are filed as a follow-up (#762 will revisit when `[MarshalAs(UnmanagedType.LPStruct)]` lands).
- When permitted, a class parameter is marshalled as a pointer (`<TypeDef for C>*`) — the runtime pins the managed object and passes its address. Documented as "classes are passed by reference."

A class without explicit `@StructLayout` (or with `@StructLayout(LayoutKind.Auto)`) used in a P/Invoke signature is reported as **GS0349** (same code as a non-blittable struct — the user remediation is identical: add the layout annotation and confirm field blittability). A class used as a P/Invoke return type is reported as **GS0351**.

### 5. Emit (`System.Reflection.Metadata`)

For each user struct / class symbol carrying a resolved `StructLayoutMetadata`:

1. Map `LayoutKind` to the matching `TypeAttributes` flag (`SequentialLayout`, `ExplicitLayout`, or `AutoLayout`) and OR it into the TypeDef's attributes. **Replaces** the previous unconditional `TypeAttributes.SequentialLayout` for `struct` and `TypeAttributes.AutoLayout` for `class` — the layout flag is derived from the resolved metadata.
2. If `Pack != null` or `Size != null`, call `MetadataBuilder.AddTypeLayout(typeDefHandle, (ushort)Pack ?? 0, (uint)Size ?? 0)` to write the `ClassLayout` row.
3. For each field carrying an `@FieldOffset(N)`, call `MetadataBuilder.AddFieldLayout(fieldDefHandle, N)` to write the `FieldLayout` row.
4. **Do not** also write `@StructLayout` or `@FieldOffset` as `CustomAttribute` rows. The CLR treats both as *pseudo-custom* attributes: their reflection surface is reconstructed from the `ClassLayout` / `FieldLayout` rows at load time, so emitting them additionally as `CustomAttribute` rows would create a duplicate reflection view (and break the C# / ILSpy round-trip).
5. The set of attribute types treated as pseudo-custom expands from `{ DllImportAttribute, LibraryImportAttribute }` (ADR-0086 §6 / ADR-0092 §6) to also include `StructLayoutAttribute`, `FieldOffsetAttribute`. The shared filter lives on `KnownAttributes.IsPseudoCustomAttribute`.

The blittable-struct parameter / return path requires no IL stub: the existing emitter encodes the struct TypeDef into the method signature exactly as it does for ordinary value-type method calls; the CLR understands a blittable value type at the P/Invoke boundary natively.

A pointer parameter `*S` continues to use the existing `EncodeTypeSymbol` pointer path; the only change is that `S` may now be a user struct.

### 6. Diagnostic catalogue (new)

| ID      | Severity | Message                                                                                                                                                              | Anchor location                                              |
|---------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------|
| GS0346  | Error    | ``@StructLayout(LayoutKind.<value>)`` is not supported; use ``LayoutKind.Sequential`` or ``LayoutKind.Explicit`` (ADR-0093).                                          | The `LayoutKind:` argument.                                  |
| GS0347  | Error    | ``Field '<Name>' of explicit-layout type '<Type>' must declare an `@FieldOffset(N)` (ADR-0093).``                                                                    | The offending field identifier.                              |
| GS0348  | Error    | ``@FieldOffset(N) is only valid on fields of a type declared with `@StructLayout(LayoutKind.Explicit)` (ADR-0093).``                                                 | The `@FieldOffset` annotation.                               |
| GS0349  | Error    | ``Type '<T>' is not blittable and cannot appear in a P/Invoke signature in v1; declare it with `@StructLayout(LayoutKind.Sequential)` (or `Explicit`) and ensure every field has a blittable type (ADR-0093).`` | The offending parameter type clause or return-type clause. |
| GS0350  | Error    | ``@FieldOffset requires a non-negative `int32` constant; got '<value>' (ADR-0093).``                                                                                 | The `@FieldOffset` argument.                                 |
| GS0351  | Error    | ``Class types are not supported as P/Invoke return values; only struct values (or `nint` for opaque handles) are permitted (ADR-0093).``                             | The return-type clause.                                      |

GS0346 fires before GS0349 (an unsupported `LayoutKind` is a hard parse-of-the-attribute failure; we don't compound it with a blittability complaint). GS0348 fires per-field; the type-level layout decision is still computed so other fields can be cross-checked.

The existing GS0323 (generic "type is not supported for marshalling") continues to apply to non-struct/class unsupported types (slices of structs, channels, sequences, etc.). The struct-specific GS0349 carries a better remediation message because the fix ("add `@StructLayout` and audit fields") is well-defined.

### 7. Interaction with ADR-0086 and ADR-0092

- `@DllImport`-annotated functions: a blittable struct parameter / return is accepted with no IL stub; the CLR marshaller passes the value by-value at the unmanaged boundary. The existing CharSet / SetLastError / CallingConvention knobs are unaffected.
- `@LibraryImport`-annotated functions: same. The two-layer outer/inner shape generated by ADR-0092 §3 does not need to allocate or free anything for a blittable struct — the struct is passed straight through both halves. If the signature contains both a blittable struct and a `string`, the outer wrapper allocates / frees the string in the existing `try / finally` and forwards the struct as a normal argument.
- Diagnostic precedence: GS0346 / GS0347 / GS0348 / GS0350 are reported during struct binding (before the function is checked); GS0349 / GS0351 are reported during P/Invoke binding (alongside GS0323 / GS0344 / GS0345). They compose freely with the existing P/Invoke diagnostics.

### 8. Interpreter behavior

The interpreter does **not** perform actual native transitions (per ADR-0086 §7 / ADR-0092 §4 it returns the declared return type's default value for any P/Invoke call). Blittable / explicit-layout structs are bound and constructable identically to other G# structs — the layout annotations do not change interpreter evaluation. The interpreter test suite therefore covers (a) that struct / class layout annotations bind without diagnostics, (b) that a P/Invoke call returning a struct yields the value-type default, and (c) that diagnostics GS0346 – GS0351 fire under the interpreter as well as the compiler.

## Consequences

- Programs can pass and receive blittable G# structs through `@DllImport` and `@LibraryImport`, removing the largest single category of "needs a C# shim" P/Invoke gaps. `gettimeofday`, `clock_gettime`, the entire Windows time / file-info API surface, and most game / graphics APIs become reachable in pure G#.
- The bound tree gains no new `BoundNodeKind`. Layout state lives on `StructSymbol.LayoutMetadata` and `FieldSymbol.ExplicitOffset`, mirroring the pattern from ADR-0086 (`FunctionSymbol.PInvokeMetadata`). The `BoundTreeExhaustivenessAllowlist` is therefore unaffected.
- The CLR pseudo-custom attribute filter expands from `{ DllImportAttribute, LibraryImportAttribute }` to also cover `StructLayoutAttribute` and `FieldOffsetAttribute`. Emitted assemblies match the ILSpy / `ildasm` decompilation of an equivalent C# program byte-for-byte at the metadata-table level (one `ClassLayout` row per laid-out type, one `FieldLayout` row per offset field, **no** `CustomAttribute` rows for the layout attributes themselves).
- `ilverify` is clean on the emitted metadata; the new emit test gates verification through `IlVerifier.Verify` exactly as the ADR-0086 / ADR-0092 emit tests already do.
- The previously deferred "struct / class marshalling" bullet on ADR-0086 §7 is now closed. The remaining v1 P/Invoke gaps (issues #760 `ref`/`out` primitives, #761 function pointers, #762 `@MarshalAs` custom marshallers) are unchanged.

## Alternatives considered

- **Auto-detect blittability without `@StructLayout`.** Rejected — the C# rule is that an `Auto`-layout struct is not blittable, and even when every field is blittable, the CLR is permitted to reorder fields. Requiring the annotation makes the user-visible ABI explicit and matches the C# convention (every BCL `[StructLayout(LayoutKind.Sequential)]` shape in `System.Runtime.InteropServices` is annotated even when the field order is "obvious").
- **Auto-derive `@FieldOffset` from field order for Explicit-layout types.** Rejected — the *whole point* of `LayoutKind.Explicit` is to opt out of automatic field placement (unions, padding, overlapping fields). Synthesizing offsets defeats the purpose; the GS0347 diagnostic is the clearer failure mode.
- **Support non-blittable structs by synthesizing per-field `MarshalAs` directives.** Deferred to issue #762 (`@MarshalAs` and custom marshallers). The CLR's runtime marshaller can handle `bool` and `char` fields with a per-field annotation, but the surface is large enough — and the `@MarshalAs` shape is already explicitly out of scope for this ADR — that it earns its own follow-up.
- **Allow classes as P/Invoke return types.** Rejected for v1 — the CLR's class-as-return contract requires the unmanaged side to return a pointer that the runtime then wraps in a new managed instance; the ownership / disposal semantics are subtle and there is no precedent for them in the rest of G#'s API surface. Filed as part of #762 follow-up considerations.
- **Always emit `@StructLayout` / `@FieldOffset` as `CustomAttribute` rows in addition to the `ClassLayout` / `FieldLayout` metadata rows.** Rejected — the CLR's BCL reflection helpers (`Type.GetCustomAttribute<StructLayoutAttribute>`, `FieldInfo.GetCustomAttribute<FieldOffsetAttribute>`) already synthesize the attribute from the metadata-table rows. Emitting both produces a duplicate visible attribute and is inconsistent with C# / `ilasm` / Roslyn emit. Matching the canonical "pseudo-custom" treatment keeps the emitted assemblies byte-identical (modulo unrelated metadata) to the corresponding C# code.
