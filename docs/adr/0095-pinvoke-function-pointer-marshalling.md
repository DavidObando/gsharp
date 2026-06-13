# ADR-0095: P/Invoke function-pointer marshalling

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Native interop follow-up; closes the "function-pointer / delegate parameter" deferral noted in ADR-0086 §7, re-listed on ADR-0092 §6 / ADR-0093 §10 / ADR-0094 §8.
- **Supersedes (partially)**: ADR-0086 §1 — the "no function-typed / delegate-typed parameter" rule enforced by GS0323 is lifted for two well-defined shapes (delegate types decorated with `@UnmanagedFunctionPointer`, and the new `unmanaged[CC] (T) -> R` raw-function-pointer type clause).
- **Related**: ADR-0086 (`@DllImport` P/Invoke), ADR-0092 (`@LibraryImport` source-generator-shaped P/Invoke), ADR-0093 (struct / class marshalling), ADR-0094 (`ref` / `out` / `in` parameters), ADR-0059 (named delegate types), ADR-0075 (arrow-form function type clause), ADR-0060 (`ref` / `out` / `in` parameters and arguments), issue #761, parent #706, prior PRs #727 (ADR-0086), #758 (ADR-0092), #759 (ADR-0093), #760 (ADR-0094).

## Context

ADR-0086 §1 required every P/Invoke parameter and return to be a primitive integer / float, a `string`, a blittable struct (added by ADR-0093), a pointer to one of those, or a slice of a primitive — but never a function-typed value. The binder reported **GS0323** ("type is not supported for P/Invoke marshalling") on every delegate or function-shaped parameter. Issue #761 tracked the gap.

Without function-pointer marshalling, the entire family of POSIX / Windows / cryptography / sort / search APIs that take a callback is unreachable from pure G#:

- POSIX `qsort(void *base, size_t nmemb, size_t size, int (*compar)(const void *, const void *))`, `bsearch(const void *key, ..., int (*compar)(const void *, const void *))` — sort / search with a user comparator.
- POSIX `signal(int signum, void (*handler)(int))`, `sigaction(...)` — register a signal handler.
- POSIX `atexit(void (*func)(void))`, `pthread_create(pthread_t *thread, ..., void *(*start_routine)(void *), void *arg)` — schedule a callback at process / thread lifetime events.
- Windows `EnumWindows(WNDENUMPROC lpEnumFunc, LPARAM lParam)`, `SetConsoleCtrlHandler(PHANDLER_ROUTINE HandlerRoutine, BOOL Add)` — register a Win32 callback.
- libsodium / libcrypto `*_callback` slots, libuv every async API, libgit2 every `*_cb`, ICU `u_loadFunction` slots — every cross-platform native library exposes at least one callback shape.

The CLR has two on-disk encodings for this:

1. **Delegate types with the runtime marshaller.** A managed delegate annotated with `[UnmanagedFunctionPointer(CallingConvention.Cdecl|Stdcall|…)]` can be passed as a parameter to a P/Invoke. The runtime allocates a thunk that converts unmanaged-to-managed calls and keeps the delegate alive while the call is in flight. After the P/Invoke returns the delegate may be GC'd; the caller MUST hold a reference for the full lifetime of any retained unmanaged thunk pointer (callbacks invoked later, e.g. `atexit`, `signal`).
2. **Raw function pointers (`delegate*` / `FNPTR`).** The CLR encodes a function-pointer-typed parameter with `ELEMENT_TYPE_FNPTR` (`0x1B`) followed by a self-contained method signature including the calling convention. The runtime hands the unmanaged address through without any GC tracking. Reception: a P/Invoke that *returns* a function pointer (e.g. `dlsym`, `GetProcAddress`) yields a value that survives the call and may be invoked through `calli`. Storage: `delegate*` is unionable with `nint` at the value level (both are address-sized integers); the type system uses the `delegate*` form for AOT / trim safety and for documenting the calling convention.

Both encodings are needed for full v1 parity with C# / Roslyn — the delegate form is the ergonomic choice for callbacks the user authors in G# (the runtime supplies the thunk), and the raw form is the only choice when consuming a function-pointer value handed back by native code (no managed delegate exists for it).

## Decision

### 1. Surface — two complementary shapes

**Shape A — named delegate type carrying `@UnmanagedFunctionPointer`.** Authors a managed delegate that the runtime marshaller converts to a callable unmanaged function pointer for the duration of each P/Invoke.

```gs
package P
import System
import System.Runtime.InteropServices

// The `@UnmanagedFunctionPointer(...)` annotation lands on the
// delegate TypeDef as `[UnmanagedFunctionPointer(CallingConvention.Cdecl)]`
// (a normal CustomAttribute row; not a pseudo-custom attribute). The
// runtime marshaller reads it to decide which native ABI the generated
// thunk should expose.
@UnmanagedFunctionPointer(CallingConvention.Cdecl)
type Int64Comparer = delegate func(a nint, b nint) int32

@DllImport("libc", EntryPoint: "qsort")
func native_qsort(base nint, nmemb nuint, size nuint, compar Int64Comparer);
```

**Shape B — `unmanaged[CC] (T) -> R` raw function-pointer type clause.** Maps to a fresh `FunctionPointerTypeSymbol` with calling convention `CC` and encodes as CLR `FNPTR` in metadata. At source level its value-domain is `IntPtr`-equivalent (every raw function pointer is an address-sized integer at runtime); to invoke a received pointer the user round-trips through `Marshal.GetDelegateForFunctionPointer<T>` to a delegate of the matching shape.

```gs
package P
import System
import System.Runtime.InteropServices

// `unmanaged[Cdecl] (nint, nint) -> int32` is the raw shape; encoded
// as `FNPTR (cdecl) (i, i) -> i4` in the MethodDef signature blob.
@DllImport("libc", EntryPoint: "bsearch")
func native_bsearch(
    key nint,
    base nint,
    nmemb nuint,
    size nuint,
    compar unmanaged[Cdecl] (nint, nint) -> int32) nint;

// Receiving a function pointer from native code — `dlsym` returns the
// address of a named symbol. The raw shape preserves the calling
// convention in metadata (AOT / trim safety) even though the runtime
// representation is just an `nint`.
@DllImport("libdl", EntryPoint: "dlsym")
func native_dlsym(handle nint, name string) unmanaged[Cdecl] () -> nint;
```

The two shapes are deliberately separate (not unified into a single "function type"). Shape A is the ergonomic on-ramp for callbacks the user authors in G#; the delegate is a real CLR object so the runtime marshaller can synthesise the thunk and the GC can track the lifetime. Shape B is the on-ramp for callbacks the user *receives* from native code; there is no managed delegate corresponding to the address, so the type system must surface the calling convention directly. The choice is at the user's discretion; nothing in the binder or emitter forces one over the other.

### 2. Calling-convention surface

Both shapes accept the same four CLR-supported calling conventions, drawn from `System.Runtime.InteropServices.CallingConvention`:

| Spelling                | CLR calling convention                  | When to use                                                                 |
|-------------------------|------------------------------------------|------------------------------------------------------------------------------|
| `Cdecl`                 | `CallingConvention.Cdecl`                | Default for most POSIX / cross-platform C libraries (caller-cleans-stack).   |
| `Stdcall`               | `CallingConvention.StdCall`              | Win32 callbacks (`WNDPROC`, `PHANDLER_ROUTINE`, `WNDENUMPROC`).             |
| `Thiscall`              | `CallingConvention.ThisCall`             | C++ instance methods exported as plain symbols (rare; v1 supports it).      |
| `Fastcall`              | `CallingConvention.FastCall`             | x86-only ABI; pass-through for completeness — not portable to ARM64.        |

**Shape A.** The convention rides on the `@UnmanagedFunctionPointer(...)` annotation. The annotation's positional argument is a `CallingConvention` enum value; if omitted the runtime defaults to `Winapi` (which the binder accepts but warns about — `Winapi` is platform-dependent, so the user should be explicit). The binder enforces that the convention matches the enclosing P/Invoke's `CallingConvention:` argument when both are explicit (GS0354).

**Shape B.** The convention sits in the `[CC]` slot of the `unmanaged[CC] (T) -> R` clause. The slot is **required** (`unmanaged (T) -> R` without `[CC]` is a parse error — GS0356). The convention name is a single identifier matched case-sensitively against the `CallingConvention` enum members (`Cdecl`, `Stdcall`, `Thiscall`, `Fastcall`). The metadata FNPTR signature is encoded with the corresponding `SignatureCallingConvention` value (`CDecl`, `StdCall`, `ThisCall`, `FastCall`).

The `Winapi` calling convention (a CLR alias that resolves to `Cdecl` on POSIX and `StdCall` on Windows) is intentionally **not** spellable in Shape B because the resulting FNPTR signature would be ambiguous across platforms. Shape A allows it (it's the `@UnmanagedFunctionPointer` default), but the binder issues a tailored remediation in GS0354 recommending an explicit `Cdecl` or `Stdcall` instead.

### 3. Delegate-shape validation (Shape A)

When the binder sees a `DelegateTypeSymbol` in a P/Invoke parameter or return position it walks the delegate's attribute list looking for `[UnmanagedFunctionPointer]`:

- If the delegate carries `@UnmanagedFunctionPointer(...)` and every parameter / return of the delegate's `Invoke` is itself marshallable (recursive application of the ADR-0086 §2 / ADR-0093 §2 / ADR-0094 §2 rules, *excluding* nested delegate / function-pointer parameters — v1 rejects nested callbacks with GS0353): accept.
- If the delegate is missing `@UnmanagedFunctionPointer`: emit **GS0353** ("delegate '{T}' used in a P/Invoke signature is missing '@UnmanagedFunctionPointer(...)' — the runtime cannot synthesise an unmanaged thunk without it"). The anchor location is the parameter / return type clause.
- If the delegate's `Invoke` carries a non-marshallable parameter / return (string, slice, class, nullable, etc.) and the delegate is otherwise well-formed: emit the existing GS0323 / GS0349 against the offending inner type, anchored to the delegate's declaration syntax.

A nested function-pointer shape (a delegate whose `Invoke` takes another delegate or `delegate*` parameter) is **explicitly rejected in v1** with GS0353. The CLR thunk generator chokes on nested unmanaged callbacks and the use case is exceedingly rare; the remediation is to flatten the API through `nint` (`Marshal.GetFunctionPointerForDelegate` round-trip).

### 4. Function-pointer shape validation (Shape B)

When the binder sees a `FunctionPointerTypeSymbol` in a P/Invoke parameter or return position it validates the inner signature:

- Calling convention must be one of `Cdecl`, `Stdcall`, `Thiscall`, `Fastcall` (parser already enforces; the binder additionally rejects `Winapi` if it somehow slips through, see §2).
- Every inner parameter type and the return type must be a primitive integer / float, `nint`, `nuint`, a blittable struct (ADR-0093), a pointer to one of those (`*T`), or another `FunctionPointerTypeSymbol` (nested function-pointer parameters are accepted — the FNPTR encoding handles them natively, unlike the runtime thunk for delegates).
- `string`, slices, classes, nullables, byref pointees, and `DelegateTypeSymbol` are rejected from inside a `FunctionPointerTypeSymbol`'s signature with the existing GS0323 anchored to the offending inner type.
- The function pointer itself may be `nint`-castable at value sites (an unmanaged function pointer is just an address). The conversion classifier treats `FunctionPointerTypeSymbol` and `nint` / `IntPtr` / `*void` as mutually convertible via an explicit cast (`as`). Implicit conversion is rejected — the user must opt in.

### 5. Diagnostics (new)

| ID      | Severity | Message                                                                                                                                                                                                                                                          | Anchor location                                          |
|---------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------|
| GS0353  | Error    | ``Delegate type '{T}' used in a P/Invoke signature is missing '@UnmanagedFunctionPointer(...)'. The runtime cannot synthesise an unmanaged thunk without it (ADR-0095). Add '@UnmanagedFunctionPointer(CallingConvention.Cdecl)' to the delegate declaration.``    | The offending parameter / return type clause.            |
| GS0354  | Error    | ``Calling-convention mismatch on '{name}': the enclosing P/Invoke declares '{outer}' but the delegate / function-pointer signature declares '{inner}'. The two must agree (ADR-0095).``                                                                            | The offending type clause / delegate declaration.        |
| GS0355  | Error    | ``Function-pointer type '{T}' is not supported as a P/Invoke return when the pointer would alias managed-allocated memory. Return 'nint' and convert via 'Marshal.GetDelegateForFunctionPointer<T>' (ADR-0095).``                                                  | The return-type clause.                                  |
| GS0356  | Error    | ``Raw function-pointer type clause must specify a calling convention in '[...]' brackets (e.g. 'unmanaged[Cdecl] (T) -> R'). 'unmanaged (T) -> R' is not accepted in v1 (ADR-0095).``                                                                              | The `unmanaged` keyword location.                        |

GS0355 fires when a P/Invoke is declared to *return* a Shape-A delegate (a managed `DelegateTypeSymbol`). Returning a delegate is unsafe — the GC has no way to track the lifetime of the unmanaged thunk pointer the runtime would conjure; whoever called the native API later may invoke through a freed thunk. The remediation is to return `nint` and convert in-band via `Marshal.GetDelegateForFunctionPointer<T>`, or to use Shape B (`unmanaged[CC] (T) -> R`) when the *raw* address is what the native API returns.

GS0356 fires when the user writes `unmanaged (T) -> R` (no calling-convention slot). Because the CLR FNPTR encoding requires a concrete calling convention, omitting `[CC]` would force an arbitrary default; v1 makes the user write it.

### 6. Parser surface (`unmanaged[CC] (T) -> R`)

`unmanaged` is a contextual keyword: it tokenises as `IdentifierToken` everywhere except at the start of a type-clause position, where the parser commits to the raw-function-pointer form when it sees the sequence `unmanaged` `[` (calling-convention slot) or `unmanaged` `(` (which is GS0356 — surface the diagnostic but still parse the rest as a function-pointer shape to keep recovery cheap). The non-keyword status keeps source-level back-compat for any identifier or member named `unmanaged`.

Grammar:

```
function-pointer-type-clause:
    'unmanaged' '[' calling-convention-identifier ']' '(' parameter-type-list? ')' '->' return-type-clause

calling-convention-identifier:
    'Cdecl' | 'Stdcall' | 'Thiscall' | 'Fastcall'
```

The parameter-type-list and return-type-clause grammar is the same as ADR-0075 §1 — no nested `[?]` modifier on the type clause (a function-pointer type is itself a value type representation; there is no notion of "nullable function pointer" distinct from a zero pointer).

The new shape produces a `TypeClauseSyntax` with:

- `IsFunctionPointer` set to `true`.
- `UnmanagedKeyword` carrying the `unmanaged` `IdentifierToken` (rewritten by the parser to record its role).
- `CallingConventionOpenBracket`, `CallingConventionIdentifier`, `CallingConventionCloseBracket` carrying the `[CC]` slot.
- `OpenParenToken`, `FunctionParameterTypes`, `CloseParenToken`, `ArrowToken`, `ReturnTypeClause` reusing the existing arrow-function machinery for the inner signature.

The CoverageMatrix golden gains `FunctionPointerType` as a `SyntaxKind` value, and no new `BoundNodeKind` value (per §8 below).

### 7. Bound-tree shape

The bound tree gains **no new** `BoundNodeKind`. The `FunctionPointerTypeSymbol` flows through the existing `TypeSymbol` lattice — every site that already accepts a `TypeSymbol` (parameter, return, local, field, call argument, etc.) accepts a function pointer transparently. The two non-trivial sites are:

1. **Parameter / return validation in `PInvokeBinder`.** A new branch in `IsSupportedMarshallingType` accepts `FunctionPointerTypeSymbol` after validating its inner signature. A new branch in the delegate-handling loop accepts `DelegateTypeSymbol` after validating its `@UnmanagedFunctionPointer` attribute. Both branches emit GS0353 / GS0354 / GS0355 on misuse and reuse existing GS0323 / GS0349 for inner-signature failures.
2. **`EncodeTypeSymbol` in the emitter.** A new branch produces a `SignatureTypeEncoder.FunctionPointer(SignatureCallingConvention, FunctionPointerAttributes.None, 0)` and then encodes the inner parameters / return type via the existing helpers.

The conversion classifier gains an entry for `FunctionPointerTypeSymbol` ↔ `nint` / `IntPtr` / `*void` (explicit-only). The conversion lowers to a CIL `conv.i` (no-op on most platforms; preserves the address). No new `BoundConversionExpression` variant is needed — the existing `Conversion` value drives the lowering.

Invocation through a function pointer is **not part of v1 surface.** The remediation is `Marshal.GetDelegateForFunctionPointer<T>(ptr)` to obtain a managed delegate of the matching shape and then invoke through the delegate. The runtime overhead is a single allocation per round-trip; for hot paths the recommendation is to cache the delegate after the first conversion (see the §11 sample). A future ADR will add a `calli`-emitting direct invocation surface once the `BoundFunctionPointerInvokeExpression` shape is agreed on (deliberately out of scope here to keep the bound-tree-discipline rule from §4 of the rules-of-engagement intact).

### 8. Emit (`System.Reflection.Metadata`)

`EmitPInvokeFunction` and `EmitLibraryImportFunction` are unchanged — they already delegate to `EncodeTypeSymbol` for parameter and return slots. The only added emit-side code is:

1. A new branch in `EncodeTypeSymbol(SignatureTypeEncoder, TypeSymbol)`:

   ```csharp
   else if (type is FunctionPointerTypeSymbol fnPtr)
   {
       var methodEncoder = encoder.FunctionPointer(
           convention: MapCallingConvention(fnPtr.CallingConvention),
           attributes: FunctionPointerAttributes.None,
           genericParameterCount: 0);
       methodEncoder.Parameters(
           fnPtr.ParameterTypes.Length,
           r => EncodeReturnSymbol(r, fnPtr.ReturnType, RefKind.None),
           ps =>
           {
               foreach (var pt in fnPtr.ParameterTypes)
               {
                   EncodeTypeSymbol(ps.AddParameter().Type(isByRef: false), pt);
               }
           });
   }
   ```

2. A `MapCallingConvention` helper that maps the `CallingConvention` enum on `FunctionPointerTypeSymbol` to the matching `SignatureCallingConvention` literal.

3. For Shape A (delegate types), no emit-side work is required. The delegate's `[UnmanagedFunctionPointer]` attribute is a normal `CustomAttribute` (not pseudo-custom — unlike `[StructLayout]` / `[DllImport]` / `[LibraryImport]` / `[FieldOffset]`), so the existing `EmitUserAttributes` pass writes it to the delegate's TypeDef row automatically once the binder validates it. The CLR runtime reads the attribute at marshalling time to decide the thunk's calling convention.

The emitted FNPTR signature is bit-compatible with the C# / Roslyn `delegate*` encoding (`ELEMENT_TYPE_FNPTR (0x1B) | calling-convention (0x05 for cdecl, 0x06 for stdcall, …) | param-count | return-type | param-types`). `ilverify` recognises it without any extension to the verifier.

### 9. Interpreter behavior

The interpreter does **not** perform actual native transitions for P/Invoke targets — for every P/Invoke target it runs the empty body the binder reserves and returns the declared return type's default value (consistent with ADR-0086 §7 / ADR-0092 §4 / ADR-0093 §8 / ADR-0094 §6). For Shape A the binder accepts the delegate parameter and the interpreter returns `default(R)` from the empty body without ever invoking the delegate. For Shape B the binder accepts the `FunctionPointerTypeSymbol` parameter / return and the interpreter again returns `default(R)` (zero `nint` for a Shape-B return) from the empty body.

The interpreter test suite covers (a) Shape-A P/Invoke declarations bind without GS0353 / GS0354 / GS0355 diagnostics, (b) Shape-A delegate parameters evaluate to the default return value without invoking the delegate, (c) Shape-B `unmanaged[CC] (T) -> R` parameters and returns parse and bind, and (d) the GS0353 / GS0356 paths are reachable from the REPL.

### 10. Interaction with ADR-0086, ADR-0092, ADR-0093, ADR-0094

- **ADR-0086** (`@DllImport`): the "no function-typed parameter" rejection at GS0323 narrows — `DelegateTypeSymbol` with `@UnmanagedFunctionPointer` and `FunctionPointerTypeSymbol` are now accepted. The CharSet / SetLastError / CallingConvention knobs on `@DllImport` remain authoritative for the *outer* function; the delegate / function-pointer's own calling convention must match (GS0354).
- **ADR-0092** (`@LibraryImport`): the outer / inner stub pair is unchanged. Both halves carry the delegate or function-pointer signature; for blittable function pointers (`FunctionPointerTypeSymbol` / a delegate decorated with `@UnmanagedFunctionPointer`) no allocation or free is required — the outer body's `ldarg.s` loads the value and forwards it to the inner P/Invoke as-is. The string marshalling pipeline is orthogonal.
- **ADR-0093** (struct marshalling): a function-pointer-typed field on a `@StructLayout`-annotated struct encodes as `FNPTR` (Shape B) or as the delegate's TypeDef reference (Shape A). The blittability classifier (`BlittableDetector`) accepts both shapes as blittable (a delegate is *not* blittable in general, but a delegate carrying `[UnmanagedFunctionPointer]` is treated as blittable for the purpose of struct embedding — the CLR runtime understands the marshalling contract).
- **ADR-0094** (`ref` / `out` / `in` parameters): function-pointer-typed slots and delegate-typed slots are not currently allowed with `ref` / `out` / `in` modifiers; the user must pass them by value. Adding `ref T` for `T = delegate*` is purely a metadata-side change and is deferred to a future ADR.
- **ADR-0059** (named delegates): the delegate declaration grammar is unchanged. The `@UnmanagedFunctionPointer` attribute is just another `Type`-targeted annotation; the only change is the small fix in `MapToSystemAttributeTargets` so a delegate declaration maps to `System.AttributeTargets.Delegate` (rather than the previous `Class`), which is what `UnmanagedFunctionPointerAttribute`'s `[AttributeUsage(AttributeTargets.Delegate)]` expects.
- **ADR-0075** (arrow function type clause): the new `unmanaged[CC] (T) -> R` clause reuses the existing `ArrowFunction` machinery for the inner shape; only the `unmanaged[CC]` prefix is new. A regular `(T) -> R` clause continues to bind to `FunctionTypeSymbol` (the managed `Action` / `Func` shape) and is rejected as a P/Invoke parameter with GS0323 — the user must opt into Shape A (named delegate) or Shape B (raw function pointer) explicitly.

### 11. Diagnostic catalogue (new)

See §5. ADR-0086 §1 GS0323 continues to fire for every other unsupported function-shape (managed `(T) -> R` / `FunctionTypeSymbol` directly used in a P/Invoke signature, e.g. `func foo(cb (int) -> int)` — the user must wrap the inner type in a named delegate carrying `@UnmanagedFunctionPointer` or switch to `unmanaged[CC] (int) -> int`).

## Consequences

- The full POSIX / Windows / cryptography callback surface becomes reachable from pure G#: `qsort`, `bsearch`, `signal`, `atexit`, `pthread_create`, `EnumWindows`, `SetConsoleCtrlHandler`, libsodium `*_callback` slots, libuv async, libgit2 `*_cb`. Together with ADR-0094 (`ref` / `out` / `in`) and ADR-0093 (struct marshalling), this closes the last v1 P/Invoke gap that forced a hand-written C# shim for realistic interop.
- The bound tree gains **no new** `BoundNodeKind` (per the rule of engagement) — function-pointer typed values flow through the existing `TypeSymbol` / `BoundExpression` hierarchy. The only addition is the new `FunctionPointerTypeSymbol` (a `TypeSymbol`) and the new parser surface for `unmanaged[CC] (T) -> R`.
- A single new `SyntaxKind` is added — `FunctionPointerType` — and surfaces in the CoverageMatrix golden snapshot.
- The `EncodeTypeSymbol` emit-side fork adds one branch (FNPTR encoding via `SignatureTypeEncoder.FunctionPointer(...)`); every other emit path is unchanged.
- `ilverify` is clean on the emitted assemblies. The ADR-0095 emit tests gate verification through `IlVerifier.Verify` exactly as the ADR-0086 / ADR-0092 / ADR-0093 / ADR-0094 emit tests do.
- The interpreter accepts both shapes without crashing and continues to return the declared return type's default value — there is no managed-IL emit pipeline under the interpreter, so callback invocation does not actually flow through native (consistent with how `@DllImport` / `@LibraryImport` behave today). The only way to observe the callback being called by native code is via the compiler (`gsc`) emit path.
- The remaining v1 P/Invoke gaps (issue #762 `@MarshalAs` custom marshallers, slices of structs, fixed-size buffers, direct `calli` invocation of `FunctionPointerTypeSymbol` values without a `Marshal.GetDelegateForFunctionPointer` round-trip) are unchanged. The direct-invocation gap in particular is the only foreseeable follow-up that would require a new `BoundNodeKind` and is deliberately deferred to a future ADR.

## Alternatives considered

- **Implement only Shape A (delegate types).** Rejected — the qsort / bsearch / dlsym family that returns a function pointer cannot be modelled by a delegate (there is no managed delegate corresponding to a native address returned by `dlsym`). Shape B is required to consume those APIs at all.
- **Implement only Shape B (raw function pointers).** Rejected — every callback the user *authors* in G# would have to be hand-converted to a function pointer (`Marshal.GetFunctionPointerForDelegate`-style), which is the C# pre-`delegate*` idiom we are explicitly leaving behind. Shape A is required for ergonomic callback authoring.
- **Use the existing `(T) -> R` `FunctionTypeSymbol` for both shapes by overloading on context.** Rejected — `FunctionTypeSymbol` represents the managed `Action` / `Func` shape (a closure that captures variables), which is incompatible with the unmanaged ABI (no `this` pointer, no captured state). Conflating the two would lose source-level documentation of *which* shape the user intends and would break overload resolution.
- **Add a `BoundFunctionPointerInvokeExpression` for direct `calli`-style invocation in v1.** Deferred — the new bound node would force exhaustive visitor updates across `BoundTreeWalker`, `BoundTreeRewriter`, `BoundNodePrinter`, `Evaluator`, `SideEffectAnalyzer`, `ControlFlowGraph`. The ADR-0095 v1 surface is complete without it: a Shape-B value can be invoked via `Marshal.GetDelegateForFunctionPointer<T>(ptr)`, which gives a delegate the user calls through the existing `BoundIndirectCallExpression`. A future ADR will add the direct-invocation path with a single focused change.
- **Allow `unmanaged (T) -> R` without `[CC]`, defaulting to `Cdecl`.** Rejected — the FNPTR encoding requires a concrete calling convention; silently defaulting would be surprising on Windows (where the platform default is `StdCall`). GS0356 forces the user to write the convention explicitly.
- **Encode Shape A delegates as raw FNPTR even without `[UnmanagedFunctionPointer]`.** Rejected — the runtime marshaller needs the attribute to synthesise the thunk; without it the runtime throws `MarshalDirectiveException` at the call site. Emitting an FNPTR signature for a delegate parameter would also be a lie at the metadata level — the runtime view of a delegate parameter is a managed `MulticastDelegate` reference, not an unmanaged address. GS0353 makes the gap a *compile-time* error so the user catches it before publishing.
- **Add `[UnmanagedCallersOnly]` support for the called *target* (callee) side.** Deferred — `[UnmanagedCallersOnly]` is a callee-side annotation on a `static` method that exposes it to the unmanaged ABI. It is orthogonal to the caller-side concern of ADR-0095 (which describes how *callers* of native APIs pass / receive function pointers). The two cleanly compose, but the callee-side surface is a future ADR.
- **Reject Shape-A delegate returns outright (no GS0355, treat them like every other rejection through GS0323).** Rejected — the tailored diagnostic is more actionable; users encountering this case almost always wanted Shape B (`unmanaged[CC] () -> R`) or a `nint` return with a deferred `Marshal.GetDelegateForFunctionPointer` conversion. GS0355 explicitly coaches both remediations.
