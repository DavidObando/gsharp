# ADR-0226: P/Invoke return marshalling overrides

- **Status**: Accepted
- **Date**: 2026-11-17
- **Phase**: Native interop correctness
- **Related**: [#6072](https://github.com/DavidObando/gsharp/issues/6072), ADR-0086, ADR-0092, ADR-0096

## Context

P/Invoke declarations accept `@return:MarshalAs(...)` but discard its pseudo-custom metadata.
For example, `U1` on a `bool` return silently falls back to the four-byte `BOOL` default.
Ordinary return attributes and parameter marshalling overrides already have separate metadata paths.

## Decision

Bind return overrides through the same compatibility checks and descriptor encoder as parameter overrides.
Store the resolved return descriptor on `FunctionSymbol`.
Emit a sequence-zero `Param` row with `HasFieldMarshal` and its complete `FieldMarshal` descriptor.
Do not emit a duplicate `MarshalAsAttribute` custom-attribute row.

For `DllImport`, attach this metadata to the native method's return parameter.
For `LibraryImport`, attach it to both the public managed wrapper and the hidden P/Invoke.
The wrapper preserves the declared contract; the inner method controls the actual native transition.
Preserve other return-target custom attributes on the public method.

Use the ADR-0096 compatibility table and diagnostics GS0357–GS0360.
Reject `ByValArray` and `ByValTStr` return overrides: these inline representations require fields.
Reject `LibraryImport` string return overrides with GS0360.
Its explicit `StringMarshalling` and non-owning pointer conversion remain authoritative.
Delegate return marshalling remains unsupported and reports GS0360.
Do not change marshalling defaults when no override is present.

## Consequences

Explicit one-byte boolean returns retain their native width.
String and array descriptors reuse existing named-argument encoding.
Metadata inspection and runtime reflection observe the same override.
No native library or unsafe test invocation is required to verify these metadata contracts.

`LibraryImport` non-string overrides continue to use the runtime marshaller on the inner P/Invoke.
This correction does not introduce explicit, blittable boolean conversion or extend NativeAOT support.

## Alternatives considered

- Diagnose every return override: safe, but needlessly rejects contracts the existing descriptor machinery can encode.
- Attach metadata only to the wrapper: preserves reflection but leaves the actual native transition incorrect.
- Add a separate return encoder: duplicates parameter rules and risks divergent metadata.
