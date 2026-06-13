# ADR-0092: `@LibraryImport` source-generator-shaped P/Invoke

- **Status**: Accepted
- **Date**: 2026-06-13
- **Phase**: Native interop follow-up; closes the `@LibraryImport` deferral in ADR-0086 §4.
- **Supersedes (partially)**: ADR-0086 §4 (`@LibraryImport` deferred to a follow-up).
- **Related**: ADR-0086 (`@DllImport` P/Invoke), ADR-0047 (Kotlin-style annotations), ADR-0027 (bespoke `System.Reflection.Metadata` emitter), issue #758, parent #706, sibling P/Invoke follow-ups #759 / #760 / #761 / #762.

## Context

ADR-0086 (issue #727) shipped G#'s first P/Invoke surface using the legacy `@DllImport` attribute. The runtime synthesises the marshalling stub on demand from the method's reflection metadata: cheap to emit, but tied to the runtime's reflection-based marshaller. This rules out AOT-only deployments (`PublishAot=true` reports IL2050/IL3050), bakes marshalling decisions into a single global table, and gives the user no way to inspect or step into the unmanaged transition.

C# 11 / .NET 7 introduced `[LibraryImport]`, a source-generator-driven replacement. The generator emits an ordinary managed wrapper that:

1. Allocates an unmanaged buffer per `string`/array parameter (per the explicit `StringMarshalling` setting).
2. Calls a hidden inner `[DllImport]` whose signature uses only blittable primitives (`IntPtr`, `int`, …).
3. Frees the unmanaged buffers in a `finally` block.

The generated wrapper is fully verifiable, AOT-friendly, and does **not** require the runtime's reflection-based marshalling stub. ADR-0086 §4 punted on this on the grounds that G# would need a source-generator infrastructure to produce both halves; issue #758 reopens that decision.

This ADR records how G# delivers the same observable behaviour as the C# generator without building a full source-generator pipeline: the binder and the existing `System.Reflection.Metadata` emitter generate the wrapper inline.

## Decision

### 1. Syntax — same shape as `@DllImport`

`@LibraryImport("libname") func Name(...) ReturnType;` is accepted by the same parser path as `@DllImport`. The semicolon body is still the "no body" marker (ADR-0086 §1); the discriminator between the two attributes is purely the attribute type.

```gs
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getpid")
func GetPid() int32;

@LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
func NativeStrLen(text string) nuint;
```

The supported attribute knobs mirror BCL `[LibraryImport]`:

| Argument                       | Position / Name | Required                                                | Notes |
|--------------------------------|-----------------|---------------------------------------------------------|-------|
| `libraryName`                  | positional 0    | yes (GS0322)                                            | Resolved to a `ModuleRef`, deduplicated with the `@DllImport` cache. |
| `EntryPoint`                   | named, optional | yes-if-present must be non-empty (GS0329)               | Defaults to the G# identifier name. |
| `SetLastError`                 | named, optional | no                                                      | Threaded through to the inner `[DllImport]`. |
| `StringMarshalling`            | named, optional | required when any `string` parameter is present (GS0344) | `Utf8` / `Utf16` only; `Custom` is rejected with GS0343 in v1. |
| `StringMarshallingCustomType`  | named, optional | reserved                                                | Accepted only when `StringMarshalling == Custom`, which v1 rejects. |

Knobs that exist on `@DllImport` but **not** on `@LibraryImport` (matching the BCL surface):

- `CharSet` — superseded by per-call `StringMarshalling`.
- `CallingConvention` — overridden via the separate `[UnmanagedCallConv]` attribute in C#; not exposed in v1.
- `PreserveSig`, `BestFitMapping`, `ThrowOnUnmappableChar` — not part of the BCL `[LibraryImport]` surface.

### 2. Marshalling table

Parameter and return types follow the same blittable list as ADR-0086 §2 (`bool`, `char`, the integer / floating-point primitives, `nint` / `nuint`, primitive pointers). The only extension is the **explicit string marshalling rule**:

| G# type | When permitted in `@LibraryImport` | Generated stub behaviour |
|---------|------------------------------------|--------------------------|
| `string` parameter | `StringMarshalling: Utf8` or `Utf16` must be explicit (GS0344). | Outer wrapper calls `Marshal.StringToCoTaskMemUTF8`/`StringToCoTaskMemUni`, stores the `IntPtr`, passes the pointer to the inner `[DllImport]`, frees the pointer in `finally` via `Marshal.FreeCoTaskMem`. |
| `string` return value | Rejected in v1 (GS0345). | Lifetime ownership across the managed/unmanaged boundary for returned strings requires either an explicit deallocator or a `MarshallerType`; both are deferred to a future ADR. |

Any other parameter type that ADR-0086 §2 already accepts is also accepted under `@LibraryImport` and passes straight through to the inner unchanged.

### 3. Generated stub shape

For each well-formed `@LibraryImport` function `F`, the emitter produces **two** CLR methods:

1. **Outer managed wrapper** — same name and visibility as `F`. `MethodAttributes.Static | MethodAttributes.HideBySig | <visibility>`. The signature uses the *user-visible* G# types unchanged (e.g. `string`). The IL body looks like:

   ```il
   .locals init ([0] native int s, [1] <returnType> ret)

       ldarg.0
       call native int [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUTF8(string)
       stloc.0
   .try
       ldloc.0
       call <returnType> <{F}>g__PInvoke|0_0(native int)
       stloc.1
       leave.s EndTry
   finally
       ldloc.0
       call void [System.Runtime.InteropServices.Marshal]::FreeCoTaskMem(native int)
       endfinally
   EndTry:
       ldloc.1
       ret
   ```

   For functions without any `string` parameter the outer body is a direct tail of `ldarg` / `call <inner>` / `ret`. For `void` returns the result local is omitted.

2. **Hidden inner P/Invoke** — name pattern `<{F}>g__PInvoke|0_0` (mirroring the C# generator's convention so decompilers display it identically). `MethodAttributes.Static | MethodAttributes.PinvokeImpl | MethodAttributes.PrivateScope`, `MethodImplAttributes.PreserveSig`, `bodyOffset = -1`, `ImplMap` row via `MetadataBuilder.AddMethodImport`. The signature substitutes `IntPtr` for every `string` parameter; everything else passes through unchanged.

The `@LibraryImport` attribute itself is **not** written out as a `CustomAttribute` on the outer wrapper (it is the user's *source* directive, fully consumed by the binder + emitter). The hidden inner does not carry a `@DllImport` CustomAttribute either — it is fully described by its `ImplMap` row.

This is the same two-layer shape C#'s source generator produces. Decompiling a G# `@LibraryImport` assembly with ILSpy yields output essentially identical to a C# `LibraryImport` partial method declaration.

### 4. Why not ship a full source-generator infrastructure?

A "real" Roslyn-style source generator would model `@LibraryImport` (and future generators) as a separate analysis pass that rewrites the syntax tree before binding. G# does not have this infrastructure today, and building it for a single attribute would be disproportionate:

- The only consumer would be `@LibraryImport`. Other CLR source generators (regex, JSON, COM) are out of scope for the language for the foreseeable future.
- The G# emitter already operates on the bound tree directly through `System.Reflection.Metadata`. Emitting the wrapper at the emit stage is a single dispatch on `PInvokeMetadata.IsLibraryImport` plus the IL-builder calls in §3 — no syntax rewrite required.
- Decoupling the wrapper into a separate pass would also require a stable surface for "generator-introduced symbols" that the rest of the binder can see (call graph, name resolution, diagnostics). That surface is large and has no other consumer.

We therefore generate the wrapper inline in the emitter and revisit the source-generator infrastructure if and when (a) at least one additional consumer is identified, **and** (b) the wrapper logic grows complex enough that bound-tree rewriting becomes the simpler implementation. Neither trigger is met today.

For the interpreter (which has no IL emit), `@LibraryImport` functions are treated identically to `@DllImport`: the binder reserves an empty body and the evaluator returns the default value for the declared return type. The interpreter is not a runtime for native interop; programs that actually need to transition to unmanaged code must be compiled with `gsc`.

### 5. Diagnostics (new)

| ID      | Severity | Message                                                                                                                                              | Anchor location                                          |
|---------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------|
| GS0342  | Error    | `Function '<Name>' is annotated with both @DllImport and @LibraryImport; choose one.`                                                                | The function identifier.                                 |
| GS0343  | Error    | `StringMarshalling value '<value>' is not a valid StringMarshalling member; use 'Utf8' or 'Utf16'.`                                                  | The `StringMarshalling:` argument.                       |
| GS0344  | Error    | `@LibraryImport function '<Name>' has a 'string' surface and must specify 'StringMarshalling: StringMarshalling.Utf8' or 'StringMarshalling.Utf16'.` | The function identifier.                                 |
| GS0345  | Error    | `@LibraryImport function '<Name>' has a 'string' return type; v1 supports 'string' only as a parameter type (see ADR-0092 §2).`                      | The return-type clause.                                  |

The ADR-0086 diagnostic set (GS0322 – GS0329) continues to apply to `@LibraryImport`: GS0322 (missing library name), GS0323 (unsupported marshalling type), GS0324 (body present), GS0325 (no body without a P/Invoke annotation), GS0326 (P/Invoke on an unsupported declaration kind), GS0329 (empty `EntryPoint`). `CharSet` (GS0327) and `CallingConvention` (GS0328) cannot fire under `@LibraryImport` because those knobs do not exist on the attribute.

### 6. Emit (`System.Reflection.Metadata`)

Row planning in `ReflectionMetadataEmitter` allocates **two** `MethodDef` rows for each `@LibraryImport` function (outer then inner). The inner row's handle is captured in `MetadataTokenCache.LibraryImportInnerHandles` so the outer body can emit a `call` to a stable token.

The inner P/Invoke is emitted before the outer body to keep the row order in sync with the planning pass: outer-then-inner row indices, parameter handles allocated in emission order.

`ilverify` runs against every assembly the emitter produces in tests, including `Issue758LibraryImportEmitTests`; the generated stubs pass under the .NET 10 runtime reference set.

### 7. Sample, spec, tests

- **Sample.** `samples/PInvokeLibraryImport.gs` calls `libc.strlen("Hello, world!")` via `@LibraryImport(..., StringMarshalling: StringMarshalling.Utf8)` and writes the length (`13`). The sample is added to `samples/CoverageMatrix` so it is exercised by the matrix regression test.
- **Spec.** The "Native interop (P/Invoke)" section gains an `@LibraryImport` subsection that lists the supported knobs, the explicit-`StringMarshalling` requirement, and the two-layer emitted shape.
- **Tests.**
  - Parser: `Issue758LibraryImportParserTests` covers `;`-bodied `@LibraryImport` declarations with each attribute knob.
  - Binder: `Issue758LibraryImportBinderTests` covers GS0342 – GS0345 plus successful acceptance.
  - Emit (CompileAndRun + ilverify): `Issue758LibraryImportEmitTests` covers `strlen` (Utf8 round-trip), `getpid` (no string), empty-string null-safe behaviour, and metadata-shape verification of the outer + hidden inner pair.
  - Interpreter: `Issue758LibraryImportInterpreterTests` confirms the bound program does not crash under the interpreter and that GS0344 fires for an under-specified declaration before evaluation.
- **Follow-ups (filed under parent #706, peers of #758):**
  - `out` / `ref` primitive parameter marshalling for `@LibraryImport` (issue #759).
  - `Span<T>` and `ReadOnlySpan<T>` parameter marshalling (issue #760).
  - `[MarshalAs]` and custom marshallers on parameters (issue #761).
  - Function-pointer / delegate parameter marshalling under `@LibraryImport` (issue #762).

## Consequences

- Programs that need AOT-friendly native interop no longer have to wrap the call in a hand-written C# `[LibraryImport]` partial method. The same surface is available directly in G# source.
- The emitter delta is modest: one new bound-tree flag (`PInvokeMetadata.IsLibraryImport`), one new emit dispatch, and an explicit IL-stub generator. There is no new bound-node kind, so the BoundTree exhaustiveness allowlist is unaffected.
- The interpreter inherits the existing P/Invoke "return default" behaviour. We document the limitation rather than masking it as a feature; it is consistent with how the interpreter treats `@DllImport` today.
- ADR-0086 §4 is now superseded; cross-links from the v1 P/Invoke ADR point to ADR-0092 for the modern attribute. The historical rationale for deferring the work is preserved in ADR-0086 for context.
- A full source-generator infrastructure is **not** added in this ADR. The trigger conditions for revisiting that decision are recorded in §4.

## Alternatives considered

- **Full source-generator pipeline (Roslyn-style).** Rejected for the reasons in §4: no second consumer, and the bound-tree rewrite would be a much larger change than emitting the wrapper inline.
- **Generate the outer body as a managed thunk that forwards to a runtime-marshalled `@DllImport`.** This was the closest C#-flavoured shortcut: the user-facing function would be a managed forwarder and the inner would carry full `MarshalAs` reflection metadata. Rejected — it does not deliver the AOT property; the runtime still synthesises a stub for the inner. The goal of `@LibraryImport` is precisely to avoid runtime-synthesised stubs.
- **Defer `@LibraryImport` until v2 in favour of a wider native-interop ADR (spans, marshallers, callbacks).** Rejected — issue #758 explicitly asks for the source-generator shape as a discrete unit. The deferred items are filed as #759 – #762 and chained off the same parent (#706).
