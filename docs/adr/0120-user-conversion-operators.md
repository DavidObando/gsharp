# ADR-0120: User-defined conversion operators (`operator implicit` / `operator explicit`)

- **Status**: Accepted
- **Date**: 2026 (this PR)
- **Phase**: Phase 7 — Stream D follow-up to ADR-0035
- **Related**: ADR-0035 (user-defined `operator` overloads — **this ADR lands the conversions it explicitly deferred**); ADR-0026 (operator-by-name deferral); ADR-0034 (imported CLR `op_*` consumption); ADR-0019 (extension functions / receiver clauses); issue #1017.

## Context

ADR-0035 shipped receiver-form binary and unary `operator` overloads on G# types but explicitly deferred **conversion operators** (`operator implicit` / `operator explicit`) to a follow-up. C# expresses these as `public static implicit operator U(T x)` / `public static explicit operator U(T x)`, emitted as the CLR special-name static methods `op_Implicit` / `op_Explicit`. The consumption side already worked: ADR-0034 / "Stream E" lets G# source call `op_Implicit` / `op_Explicit` declared on imported CLR types. What remained was a way to *declare* conversions on G#-owned types so user code can write natural conversions that round-trip to other CLR languages.

The motivating case (issue #1017, discovered migrating `Oahu.Decrypt`'s `IAppleData.cs` via cs2gs / #914) is a struct that converts to and from `[]uint8`:

```csharp
public readonly struct AppleData {
    private readonly byte[] _bytes;
    public static implicit operator byte[](AppleData d) => d._bytes;
    public static explicit operator AppleData(byte[] b) => new(b);
}
```

## Decision

Ship user-defined implicit and explicit conversion operators on G#-owned `struct` types.

### Syntax

A conversion operator is **static** (no receiver instance) and both the source operand type and the target type matter, so the receiver-clause form used by binary/unary operators does not fit. Instead, conversions compose with the existing grammar as `operator` followed by a **contextual keyword** `implicit` or `explicit`, then a single-parameter list (the source operand) and a return type (the target):

```gsharp
struct AppleData {
    var bytes []uint8
}

// implicit: AppleData → []uint8
func operator implicit (d AppleData) []uint8 {
    return d.bytes
}

// explicit: []uint8 → AppleData
func operator explicit (b []uint8) AppleData {
    return AppleData{bytes: b}
}
```

The single parameter's type is the **source**; the return type is the **target**. `implicit` and `explicit` are recognized **only** immediately after `operator` — neither becomes a reserved keyword elsewhere. Conversions take the free-function (no receiver) form because at least one of source/target — but not necessarily an instance receiver — is the owning type.

### Rules (mirroring C#)

- Implicitly **static**; exactly **one** by-value parameter.
- At least one of the source or target type must be a `struct` owned by the current package, and the two types must differ.
- A given source/target pair may have only **one** conversion (implicit *or* explicit), not both.

These are enforced with diagnostics `GS0393` (wrong parameter count), `GS0394` (neither side is an owned struct, or source == target), and `GS0395` (duplicate source/target pair).

### Binding & symbols

The parser synthesizes an `IdentifierToken` whose text is the resolved `op_Implicit` / `op_Explicit` name and flags the declaration as a conversion operator. The binder models it as a static `FunctionSymbol` (`IsStatic = true`, `IsSpecialName = true`, no receiver) attached to the owning `StructSymbol` via a new `AddStaticMethods` append (owner struct members are already bound by the time top-level functions bind). No new `SyntaxKind` or `BoundNodeKind` is introduced — the applied conversion reuses `BoundCallExpression(null, op, [operand])`.

### Conversion resolution

Same-package G# structs have a null `ClrType` at bind time, so the reflection-based `ClrOperatorResolution` (used for imported conversions) cannot see them. A symbolic lookup over `StructSymbol.StaticMethods` resolves same-compilation conversions and is wired into:

- `ConversionClassifier.BindConversion` — assignment / target-typed contexts and the explicit cast form `U(x)`.
- `ConversionClassifier.TryApplyUserDefinedImplicitArgumentConversion` — argument passing during overload resolution.

Implicit conversions apply automatically (assignment, argument passing, target-typed positions); explicit conversions apply at the type-call cast form `U(x)`. Imported CLR `op_Implicit` / `op_Explicit` continue to resolve via ADR-0034.

### Emit

The operator emits as a `public static hidebysig specialname` method named `op_Implicit` / `op_Explicit` with signature `U (T)`. When a conversion is applied the compiler emits a non-virtual `call` to the operator.

## Consequences

- G# can now both declare and consume CLR conversion operators, closing the last gap from ADR-0035's deferral list for conversions.
- Conversions are restricted to owned `struct` targets/sources in this PR; class conversions and the full C# best-conversion lifting rules (chained user + standard conversions, nullable lifting) are intentionally limited to the common direct cases.
- The `Oahu.Decrypt` migration (#914) can express `AppleData ⇄ []uint8`.

## Alternatives considered

- **Receiver-clause form** (`func (d AppleData) operator implicit() []uint8`): rejected — conversions are static and the source can be the *parameter* rather than a receiver instance, so a receiver clause is misleading and cannot express `[]uint8 → AppleData`.
- **C#-style `implicit operator U(T x)`** placing the target before the parameter list: rejected — it does not compose with G#'s `func … ReturnType` shape, where the return type already names the target.
