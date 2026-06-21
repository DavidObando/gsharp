# ADR-0109: Top-level `private` maps to IL `assembly` (internal)

- **Status**: Accepted
- **Date**: 2026-06-20
- **Phase**: Phase 5 — generics & dogfooded core
- **Closes**: Issue #909 (top-level `private func` causes runtime `MethodAccessException` when called from another type)
- **Related**: ADR-0066 (top-level statements / synthetic `<Program>` host);
  ADR-0090 (private interface helper methods)

## Context

G# top-level declarations (functions written directly in a package, not
inside a `class`/`struct`/`interface`) are emitted as static members of a
synthetic per-package `<Program>` type. A sibling top-level `class` in the
same file/assembly is emitted as its own CLR `TypeDef`.

The binder's accessibility model treats a top-level `private` function as
reachable from sibling top-level types in the same assembly — so it
*permits* a user `class` to call a top-level `private func`. But emission
mapped source `private` to IL `MethodAttributes.Private`
(`src/Core/CodeAnalysis/Emit/AccessibilityMap.cs`), and the CLR enforces
IL `private` as *private-to-the-declaring-type* (`<Program>`). The binder's
model and the emitted IL therefore **disagreed**, producing a clean compile
followed by a runtime fault:

```gsharp
package Oahu.Cli.Tests

import System

private func Helper() string {
    return "hello"
}

class Greeter {
    func CallIt() string {
        return Helper()        // direct call
    }
    func MakeDelegate() Func[string] {
        return Helper          // method-group delegate
    }
}
```

```
System.MethodAccessException: Attempt by method
'Oahu.Cli.Tests.Greeter.CallIt()' to access method
'Oahu.Cli.Tests.<Program>.Helper()' failed.
```

`ilverify` likewise flagged the emitted assembly with
`[MethodAccess] ... Method is not visible.` for both the direct call and the
method-group-delegate (`ldftn`) forms. Default (no-modifier) top-level
functions were unaffected — they are emitted `public static` and already
worked; only an *explicit* `private` modifier was broken.

A top-level `private` most naturally means "module/file-private, not
exported from the assembly". The closest CLR accessibility for that intent
is IL `assembly` (internal): visible to every type in the same assembly, but
not exported to consumers.

## Decision

Emit top-level `private` functions — members of the synthetic `<Program>`
type — as IL `assembly` (internal) instead of IL `private`, so the IL
accessibility matches what the binder already permits (cross-type access
within the assembly).

The remapping lives in the single accessibility-mapping helper used by every
function-emit path:

```csharp
// AccessibilityMap.cs
public static MethodAttributes ToMethodVisibility(
    Accessibility accessibility, bool isTopLevelProgramMember)
{
    if (isTopLevelProgramMember && accessibility == Accessibility.Private)
    {
        return MethodAttributes.Assembly; // IL `assembly` (internal)
    }

    return ToMethodVisibility(accessibility);
}

public static bool IsTopLevelProgramMember(FunctionSymbol function)
    => !function.IsInstanceMethod && function.StaticOwnerType is null;
```

`ReflectionMetadataEmitter` passes
`AccessibilityMap.IsTopLevelProgramMember(function)` at all three function
MethodDef-visibility sites — the ordinary function path (`EmitFunction`), the
P/Invoke path (`EmitPInvokeFunction`), and the `@LibraryImport` outer-stub
path (`EmitLibraryImportFunction`) — so every kind of top-level `private`
function is emitted consistently.

A function is a `<Program>` member when it is **not** an instance method
(`ReceiverType is null`) and carries **no** `StaticOwnerType` (which is set
for `shared`/static methods owned by a user `struct`/`class`/`interface`).
This covers plain top-level functions, extension functions, and
non-capturing lambda host methods — all hosted on `<Program>` — while
excluding every member of a user-defined type.

## Consequences

### Positive

- The repro compiles, passes `ilverify`, and executes without
  `MethodAccessException` for **both** the direct call `Helper()` and the
  method-group delegate `return Helper`.
- The binder's existing accessibility model and the emitted IL now agree, so
  "compiles clean but faults at runtime" can no longer occur for this case.
- No binder/diagnostic changes are required; existing code that legitimately
  calls top-level `private` helpers from sibling top-level types keeps
  working, now soundly.

### Negative

- A top-level `private` function is technically reachable by any type in the
  same assembly (IL `assembly`), which is slightly broader than the word
  "private" might suggest. This matches the binder's already-permitted
  semantics and the "module/file-private, not exported" intent; it does not
  export the member from the assembly.

### Out of scope

- User-type `private` is deliberately **unchanged**: a `private`
  method/field on a normal `class`/`struct`/`interface` still maps to IL
  `private` and the CLR continues to enforce real type privacy. The
  remapping is gated strictly on `IsTopLevelProgramMember`.
- Default (no-modifier) top-level functions remain `public static`.
- Tightening top-level `private` to be genuinely type-private (e.g. by
  moving top-level members into per-file nested types) is not pursued here.

## Test coverage

`test/Compiler.Tests/Emit/Issue909TopLevelPrivateAccessibilityEmitTests.cs`:

- `TopLevelPrivateFunc_DirectCallFromSiblingType_Runs` — compiles, runs
  `ilverify`, and executes the direct-call repro; asserts output `hello`.
- `TopLevelPrivateFunc_MethodGroupDelegateFromSiblingType_Runs` — same for
  the method-group-delegate (`return Helper`) form.
- `TopLevelPrivateFunc_BothFormsTogether_Runs` — exercises both forms in one
  assembly.
- `TopLevelPrivateFunc_IsEmittedAssemblyVisible` — reads the emitted
  metadata and asserts the top-level `Helper` MethodDef is IL `assembly`.
- `UserClassPrivateMethod_RemainsIlPrivate` — guard asserting that a
  `private` method on a user `class` is still emitted IL `private`
  (scoping is preserved; user-type privacy is not weakened).

## Alternatives considered

- **Option 2 — compile-time accessibility diagnostic.** Keep IL `private`
  and instead make the binder *reject* cross-type access to a top-level
  `private` function, surfacing a compile error rather than a runtime fault.
  This was rejected because it removes useful, already-working behavior
  (top-level `private` helpers shared among sibling top-level types in a
  file are idiomatic), changes the language in a more restrictive direction,
  and would require reworking the binder's accessibility model rather than
  aligning emission with it. Option 1 keeps the permissive, ergonomic
  behavior the binder already implements and simply makes the emitted IL
  honest about it.
- **Per-file nested host type.** Emit each file's top-level members into a
  distinct nested type so `private` could be genuinely type-private. This is
  a much larger metadata-layout change to `<Program>` hosting for no
  user-visible benefit over Option 1, and was rejected as out of scope.
