# ADR-0086: P/Invoke (`@DllImport`) native interop

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Native interop bootstrap; unblocks ADR-0047 §6 (`[DllImport]` v1.0 deferral)
- **Supersedes (partially)**: ADR-0047 §6 deferral of `[DllImport]` (GS0211 blanket rejection)
- **Related**: ADR-0047 (Kotlin-style annotations), ADR-0027 (bespoke `System.Reflection.Metadata` emitter), issue #727, parent #706.

## Context

G# until now rejected `@DllImport` outright with diagnostic GS0211 ("Attribute '[DllImport]' is recognised but not supported in v1.0; P/Invoke (extern function bodies) is a post-v1.0 feature."). Any G# program that needed to call native code therefore had to be wrapped by a hand-written C# shim, which is a hard interop block for anything below the BCL surface (libc, kernel32, custom native libraries, hardware/OS APIs, third-party C/C++ libraries).

Issue #727 (under parent #706) requires that G# emit real CLR P/Invoke metadata so unmanaged functions can be called directly from G# source, matching C#'s `[DllImport]` semantics. The implementation must produce a `MethodAttributes.PinvokeImpl` method with an `ImplMap` row pointing at a `ModuleRef`, marshal the supported primitives correctly, and verify clean under `ilverify`.

## Decision

### 1. Syntax — `@DllImport("libname") func Name(...) ReturnType;`

A P/Invoke declaration is **an ordinary `func` declaration** annotated with `@DllImport(...)` whose **body marker is `;`** (semicolon) instead of `{ ... }`. The semicolon **is** the "no body" marker — there is no new `extern` keyword.

> **Note (issue #881):** the `;` no-body marker is no longer P/Invoke-specific. Issue #881 makes `;` the **universal** no-body marker for every body-less `func`, including interface abstract methods and interface `shared { … }` abstract static slots (see ADR-0085's "Revision (issue #881)"). P/Invoke's surface is unchanged; it is now the norm rather than the exception.

```gs
package P
import System.Runtime.InteropServices

@DllImport("libc")
func getpid() int32;

@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
func strlen(s string) nuint;
```

Rationale for the attribute-driven shape (over a dedicated `extern func` form):

- **CLR alignment.** `[DllImport]` round-trips through every CLR-aware tool (ildasm, reflection, decompilers) with zero translation. C# users reading G# P/Invoke see exactly the shape they already know.
- **No new keywords.** `extern` would have to become a contextual keyword (G# already pays this cost for `ref`, `open`, `override`, `async`, etc.) and would introduce a one-of-a-kind body-shape grammar fork (`extern` body vs `{}` body). The semicolon-as-no-body shape reuses the existing optional-body slot the interface-DIM parser already produces.
- **Forward-compatible with `@LibraryImport`.** The same parser shape — annotated `func` with `;` body — accepts the source-generator-style `@LibraryImport` attribute when we add it. The discriminator is purely the attribute type.

#### Grammar delta

`FunctionDeclarationSyntax` gains an optional `SemicolonToken` body-substitute. The parser:

- If the next token after the return-type clause is `{`, parses a block-statement body as today.
- Else if the next token is `;`, consumes it as `SemicolonToken` and leaves `Body == null`.
- Else, the parser falls back to the standard `MatchToken(SyntaxKind.OpenBraceToken)` path so the existing missing-`{` diagnostic is unchanged.

A `;`-bodied `func` is **only** legal when at least one well-formed `@DllImport` annotation is present; otherwise GS0322 is reported (see §3).

### 2. Marshalling table — v1 supported types

A P/Invoke parameter or return type is **valid in v1** if and only if it falls into one of the rows below. Anything else produces **GS0323** (unsupported marshalling type) at the parameter or return-type-clause location; the function is dropped from emit.

| G# type                          | CLR signature       | Marshalling default                        |
|----------------------------------|---------------------|--------------------------------------------|
| `bool`                           | `System.Boolean`    | 4-byte Windows `BOOL` (CLR default).       |
| `char`                           | `System.Char`       | UTF-16 code unit; `CharSet` does not alter the per-`char` width. |
| `int8` / `uint8`                 | `System.SByte` / `System.Byte`   |                                            |
| `int16` / `uint16`               | `System.Int16` / `System.UInt16` |                                            |
| `int32` / `uint32`               | `System.Int32` / `System.UInt32` |                                            |
| `int64` / `uint64`               | `System.Int64` / `System.UInt64` |                                            |
| `float32` / `float64`            | `System.Single` / `System.Double` |                                          |
| `nint` / `nuint`                 | `System.IntPtr` / `System.UIntPtr` |                                          |
| `string`                         | `System.String`     | Marshalled per `CharSet` (default: `CharSet.Ansi`, matching CLR default). |
| `*T` (where `T` is a primitive)  | `T*` (unmanaged pointer) | Raw pointer; not GC-tracked.            |
| `[]T` for primitive `T`          | `T[]` (managed array) | Marshalled as an LPArray; pinned and a base pointer passed. |
| `SafeHandle` (and derived)       | `System.Runtime.InteropServices.SafeHandle` (or subclass, e.g. `Microsoft.Win32.SafeHandles.SafeFileHandle`) | The CLR marshaller special-cases `SafeHandle`: as a parameter it adds a ref to the handle for the duration of the call; as a return value it constructs the managed wrapper and takes ownership of the native handle. Not blittable and not a pointer — accepted as a managed reference type. |
| `void` (return only)             | `System.Void`       |                                            |

**Not yet supported in v1** (diagnose with GS0323; tracked in follow-up issues):

- Struct/class types (custom marshalling, blittability checks, `[StructLayout]`).
- Delegates as function pointers (`[MarshalAs(UnmanagedType.FunctionPtr)]`).
- Out / ref parameters with primitive types (filed as follow-up #728).
- Custom marshallers (`[MarshalAs(CustomMarshaler = ...)]`).
- `StringBuilder`.
- `@LibraryImport` source-generator pattern (filed as follow-up #729).

#### 2.1 `SafeHandle` marshalling (issue #1208)

`System.Runtime.InteropServices.SafeHandle` and any type that derives from it
(e.g. `Microsoft.Win32.SafeHandles.SafeFileHandle`,
`Microsoft.Win32.SafeHandles.SafeWaitHandle`) are accepted as a P/Invoke
**parameter** and as a **return value**. `SafeHandle` is the standard,
idiomatic way to write safe Win32 interop in .NET: the CLR marshaller performs
the handle ref-count / lifetime bookkeeping automatically, so the canonical
`CreateFile` → `SafeFileHandle` / `ReadFile(SafeHandle, …)` shape compiles and
emits a `PinvokeImpl` method whose signature references the real handle type via
a `TypeRef`. The binder detects "is or derives from `SafeHandle`" by walking the
CLR base-type chain on the type's `ClrType` and comparing the full name
`System.Runtime.InteropServices.SafeHandle` — only `SafeHandle` and its
subclasses are accepted; arbitrary reference types are **not** broadened in (a
`StringBuilder` parameter or an arbitrary class return is still rejected with
GS0323). `SafeHandle` is neither blittable nor a pointer, so it bypasses the
struct / pointer blittability checks (it is a managed reference type the
marshaller special-cases). The emitter needs no marshalling-specific gate: the
general method-signature type encoder emits the handle type's `TypeRef`
directly, and the runtime marshaller does the rest.

### 3. Attribute knobs

`@DllImport` accepts the following arguments (matching the CLR field/property surface on `DllImportAttribute`):

| Argument           | Kind       | Default                                          | Notes |
|--------------------|------------|--------------------------------------------------|-------|
| `libraryName`      | positional, **required** | — (GS0322 if missing)                    | Name of the unmanaged library. Resolved by the CLR using its native-library search order; G# does not impose its own. |
| `EntryPoint`       | named, optional | The G# function's own name                  | Name of the unmanaged entry point. |
| `CharSet`          | named, optional | `CharSet.Ansi` (CLR default)               | Drives string marshalling and the `ExactSpelling` default. |
| `SetLastError`     | named, optional | `false`                                    | When `true`, CLR captures the OS error after the call so `Marshal.GetLastWin32Error()` returns the value the native function set. |
| `CallingConvention`| named, optional | `CallingConvention.Winapi`                | `Winapi`, `Cdecl`, `StdCall`, `ThisCall`, `FastCall`. |
| `ExactSpelling`    | named, optional | `false` for `CharSet.Ansi`/`None`, `true` for `Auto` (matches CLR default) | When `false`, the CLR may append `A`/`W` suffixes for `Ansi`/`Unicode` charsets. |
| `PreserveSig`      | named, optional | `true`                                     | When `false`, swaps an `HRESULT` return for a thrown exception (mostly a COM convenience; emitted faithfully but not exercised in v1 tests). |
| `BestFitMapping`   | named, optional | not set                                    | Threaded through if specified. |
| `ThrowOnUnmappableChar` | named, optional | not set                                | Threaded through if specified. |

Any **unknown named argument** falls through to the standard "no matching property" diagnostic from the existing attribute-arg binder (GS0207). Type mismatches use the existing GS0205/GS0206 codes.

### 4. `@LibraryImport` — implemented in ADR-0092 (issue #758)

The modern C# 11+ source-generator attribute (`[LibraryImport]`) produces an equivalent — and in places safer — managed/unmanaged transition than `[DllImport]`. v1 of G# P/Invoke shipped with `@DllImport` only; **ADR-0092** (issue #758) supersedes this deferral and adds `@LibraryImport` support: the binder accepts the source-generator-shaped attribute, the emitter generates an explicit managed marshalling stub (outer method) that calls a hidden blittable inner P/Invoke, and the IL is verifiable. The runtime never auto-marshals strings for an `@LibraryImport` declaration. See **ADR-0092** for the marshalling rules, generated-stub IL shape, and diagnostics GS0342–GS0344.

The original rationale for deferring `@LibraryImport` is preserved here for historical context:

- `LibraryImport` is itself implemented in C# as a source generator that emits a `DllImport`-flavored unmanaged callee plus a managed wrapper. G# would need to model both layers, including the `MarshalAs` shapes that surface on the wrapper's parameters. That is substantially larger than the v1 surface area.
- Every benefit of `LibraryImport` (no runtime marshalling stub generation, AOT-friendly) is also achievable, in principle, by emitting `DllImport` with a `PreserveSig`-true / `SetLastError`-driven shape that does not require runtime IL stubs. v1's emitted P/Invoke metadata is AOT-publishable.
- Punting `LibraryImport` keeps the v1 diagnostic surface small (8 codes) and the emitter delta to a single `AddMethodImport` call.

ADR-0092 picks up exactly this two-layer (outer wrapper + inner unmanaged callee) shape: the outer is generated in IL by the compiler rather than by a separate source generator, and the `MarshalAs` surface is narrowed to the explicit `StringMarshalling` enum so the v1 marshalling table extension is small.

### 5. Diagnostic catalogue (new)

| ID      | Severity | Message                                                                                                                 | Anchor location                                         |
|---------|----------|-------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------|
| GS0322  | Error    | `@DllImport requires a non-empty library name as the first positional argument.`                                        | The `@DllImport` annotation.                            |
| GS0323  | Error    | `Type '<T>' is not supported for P/Invoke marshalling in v1; see ADR-0086 §2.`                                          | The offending parameter type clause or return-type clause. |
| GS0324  | Error    | `P/Invoke function '<Name>' must not have a body; replace the `{ ... }` block with `;`.`                                | The function's body block.                              |
| GS0325  | Error    | `Function '<Name>' has no body; only `@DllImport`-annotated functions may declare a `;`-only body.`                     | The function identifier.                                |
| GS0326  | Error    | ``@DllImport` is invalid on '<Name>': only top-level `func` declarations are supported in v1 (no instance methods, no async, no generics, no extension methods, no ref-returns).` | The function identifier. |
| GS0327  | Error    | `CharSet value '<value>' is not a valid `CharSet` member.`                                                              | The `CharSet:` argument.                                |
| GS0328  | Error    | `CallingConvention value '<value>' is not a valid `CallingConvention` member.`                                          | The `CallingConvention:` argument.                      |
| GS0329  | Error    | ``@DllImport.EntryPoint` must be a non-empty string literal.`                                                           | The `EntryPoint:` argument.                             |

The historical **GS0211** ("Attribute `[DllImport]` is recognised but not supported in v1.0") is **no longer fired** when the declaration is well-formed (semicolon body present, library name present, every parameter type supported). The diagnostic code is retained as a reserved slot for backwards compatibility — its message is reworded to indicate that any remaining occurrences come from an attribute applied to something other than a P/Invoke-shaped declaration.

### 6. Emit (`System.Reflection.Metadata`)

For each well-formed P/Invoke function `F`:

1. Add a `ModuleReference` row for the resolved library name (deduplicated by name).
2. Encode the method signature with the **same** `BlobEncoder.MethodSignature(isInstanceMethod: false)` path used for ordinary static functions; primitives map through the existing `EncodeTypeSymbol` path. `string` uses `String`, `nint`/`nuint` use `IntPtr`/`UIntPtr`, primitive pointers use the existing `*T` encoding.
3. Emit a `MethodDefinition` with `MethodAttributes.Static | MethodAttributes.PinvokeImpl | MethodAttributes.HideBySig | <visibility>`, `MethodImplAttributes.PreserveSig` (unless `PreserveSig: false`), `bodyOffset = -1` (no IL body), and the usual parameter list.
4. Emit an `ImplMap` row via `MetadataBuilder.AddMethodImport(method, attrs, entryPoint, moduleRef)` where `attrs` encodes the calling convention, `CharSet`, `SetLastError`, and `ExactSpelling` flags.

`@DllImport` arguments **are not** also written out as a `CustomAttribute` row on the method (mirroring C#'s behavior): the attribute is fully consumed by the `ImplMap` row, so duplicating it would create a misleading reflection view.

### 7. Sample, spec, and follow-ups

- **Sample.** `samples/PInvoke.gs` calls `libc.getpid` (cross-platform on Linux and macOS, with a `RuntimeInformation.IsOSPlatform`-gated skip on Windows). The sample is added to `samples/CoverageMatrix` so it is exercised by the matrix regression test.
- **Spec.** A new "Native interop (P/Invoke)" section is added under the spec; the lexical grammar gets the optional `;` body marker on `func` declarations. The diagnostics reference (`website/docs/ref/diagnostics.md` mirror) lists every new code.
- **Follow-ups (filed under parent #706):**
  - `@LibraryImport` source-generator attribute support — **completed by ADR-0092 (issue #758).**
  - `out` / `ref` primitive parameter marshalling for P/Invoke (issue #728).
  - Struct-by-value and `[StructLayout]` marshalling (issue #730).
  - Function-pointer / delegate parameter marshalling (issue #731).

## Consequences

- Programs can call native code directly without a C# shim. The full CLR ABI for `[DllImport]` is available, modulo the v1 marshalling table.
- `GS0211`'s blanket-rejection role is removed; existing programs that relied on `GS0211` to flag accidental use are unaffected because well-formed P/Invoke declarations now succeed (the historically-rejected shape — `@DllImport` on a method with a body — fires GS0324 instead). Programs without a body and without `@DllImport` still fail, now with GS0325.
- The bound tree gains no new `BoundNodeKind`: P/Invoke is modelled by two new flags (`IsPInvoke`, `PInvokeMetadata`) on `FunctionSymbol`. The bound-tree exhaustiveness guards therefore do not need to widen.
- IL verification (`ilverify`) is clean on the emitted metadata; the new sample is gated through `IlVerifier.Verify` in its emit test.
