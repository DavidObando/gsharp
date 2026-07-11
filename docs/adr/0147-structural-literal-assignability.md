# ADR-0147: Structural literal-to-type assignability (TypeScript-style width subtyping)

- **Status**: Implemented
- **Date**: 2026-07-11
- **Phase**: Phase 3.B (OO surface) follow-on
- **Related**: ADR-0146 (anonymous-object literal — the source literal this feature consumes); ADR-0017 (nominal class/interface conformance — explicitly NOT changed by this ADR); ADR-0029 (data struct synthesized members); ADR-0085 (default interface methods — the CLR `InterfaceImpl` emission this ADR deliberately avoids for interface targets).
- **Implementation**: `Conversion.Classify` + `StructuralConversionSatisfiesMembers` (`src/Core/CodeAnalysis/Binding/Conversion.cs`), `ConversionClassifier.BindStructuralRecordConversion` (`src/Core/CodeAnalysis/Binding/ConversionClassifier.cs`), `BindAnonymousClassExpression` (`src/Core/CodeAnalysis/Binding/ExpressionBinder.Literals.cs`), `OverloadResolver` structural argument lowering (`src/Core/CodeAnalysis/Binding/OverloadResolver.cs`).

## Context

G# is **nominal** today. Assignability and interface conformance are keyed on named-type identity, a base-class walk, and the declared `: I` interface set. The conformance check lives in `VerifyInterfaceImplementations` (`DeclarationBinder.cs:3614`) and is driven entirely by `StructSymbol.Interfaces` / `ImplementedClrInterfaces` (populated by the `: I` clause). The single conversion classifier `Conversion.Classify` (`Conversion.cs:96`) has exactly two structural arms — function↔delegate signature matching (`IsFunctionStructurallyAssignable`, `Conversion.cs:1728`) and element-wise tuple conversion — plus declaration-site generic-interface variance. There is **no** path where `object{a:1}` is accepted where a named type such as `Point{X:int}` is expected; `Conversion.Classify(anonStruct, Foo)` falls through to `Conversion.None` and reports `GS0155`.

TypeScript users expect **structural** assignment: a value is assignable to a type when its shape satisfies the target's required members, regardless of declared conformance, with **width subtyping** (extra members allowed). This is useful for G# because it lets callers build ad-hoc values against data classes / structs / classes without declaring a named type for every shape, and it matches the ergonomics of the `object{...}` literals already in the language (`ADR-0146`).

This ADR is deliberately scoped to **literal → type assignability only**. It does **not** make interface conformance structural (you still write `: I`); it only lets a structural *literal* be assigned to a concrete target type. This keeps the change CLR-safe: we *construct* the target value from the literal's members at the conversion site, so no new `InterfaceImpl` metadata row is required.

## Decision

Add a new implicit conversion kind `Structural` to `Conversion` (`Conversion.cs:15` family). It is classified in `Conversion.Classify` when a source anonymous `StructSymbol` (an `object{...}` / `data object{...}` synthesized type — identified by having no declaring syntax node) is assigned to a **concrete non-abstract target** `StructSymbol` (class / struct / `data struct`) whose required members are all present in the source with implicitly-convertible types.

**Membership test (classify time):**
- `StructuralConversionSatisfiesMembers` enumerates the target's instance fields (`target.Fields`) and settable properties (`target.Properties` with a setter or auto-property accessor). Non-settable properties are not checked.
- For each target member, `TryFindSourceMember` looks up a same-named member in the source's `Fields` and `Properties`, then requires `Conversion.Classify(sourceMember.Type, targetMember.Type).IsImplicit`.
- **Width subtyping**: source members with no matching target member are ignored (allowed).
- **Missing / incompatible** target members cause `Conversion.None` — the structural arm is not entered, so overload resolution sees a type mismatch rather than a specific "missing member" diagnostic. This prevents overload resolution from selecting candidates whose literals would fail to satisfy the target.

**Lowering** (`ConversionClassifier.BindStructuralRecordConversion`): when the classified conversion is `Structural`, `BindStructuralRecordConversion` builds a `BoundStructLiteralExpression` of the **target** type by iterating `target.Fields` and `target.Properties` (settable only), matching each by name against the source literal's members via `GetObjectLiteralMemberValues`. Each matched value is run through `BindConversion` for per-member implicit conversion. A plain `BoundConversionExpression` cast is intentionally **not** used: the source anonymous type and the target type are distinct CLR types, so the value must be *rebuilt* as the target.

**Literal forms:**
- `object{a:1}` (already supported via `BindAnonymousClassExpression`) becomes structurally assignable to a compatible target.
- Empty `object{}` is accepted; `AnonymousTypeCache.GetOrCreate` handles a zero-member `(name,type)` shape, producing a zero-member synthesized `StructSymbol` that satisfies a target with no required members.

**Overload resolution**: the `OverloadResolver` argument-conversion loop (`OverloadResolver.cs:5956`) detects structural conversions via `Conversion.Classify(...).IsStructural` and lowers them through `BindConversion` before the implicit-pass-through path, ensuring the anonymous source value is rebuilt as the target type at the call site.

**Out of scope (v1):**
- **Interface-typed targets** (`const x: IShape = object{Area:...}`). Without a declared `: I` the CLR has no `InterfaceImpl` row (`ADR-0085`), so this would require synthesizing an anonymous class that implements `IShape` (reuse `SynthesizeAnonymousClassDeclaration`, `Binder.cs:2029`). Deferred to a follow-up.
- **Structural conformance of named types** (dropping the `: I` requirement). Explicitly NOT addressed; `: I` remains mandatory for class/struct interface implementation. This keeps `VerifyInterfaceImplementations` unchanged.

## Consequences

Positive:
- Mirrors TypeScript's width-subtyping ergonomics for literals against data classes / structs / classes.
- CLR-safe: no new metadata rows; the target value is constructed at the literal site.
- No new `SyntaxKind` / `BoundNodeKind` required; reuses `AnonymousTypeCache`, `BoundStructLiteralExpression`, and `BoundFieldInitializer`.
- Strict classification (members validated at classify time) prevents overload resolution from selecting candidates with unsatisfiable literal shapes.

Negative / follow-ups:
- Only literals benefit; a named type with the right shape still does not satisfy an unrelated target without an explicit conversion or declaration. (Acceptable — matches the chosen scope.)
- Interface targets are not supported in v1; callers needing `: I` must still declare conformance or use the rich `object : I { ... }` form from ADR-0146.
- Missing/incompatible members produce a generic type-mismatch error (from overload resolution) rather than a specific "missing member X" diagnostic. A more specific error could be added as a follow-up.

## Alternatives considered

1. **Bare `{}` empty-object syntax.** Rejected for v1: G# has no bare `{}`; `{` is overloaded (switch arms, `Type{…}`, `map[K]V{…}`, collection initializers, `object{…}`), so a bare `{}` needs disambiguation. It also requires *contextual typing* (the literal has no intrinsic type) — a deferred bind pass the binder does not have for literals today. Empty literals add little (an empty literal cannot satisfy a type with required members anyway). `object{}` already yields a known synthesized type and is reused instead. Bare `{}` can be layered on later as sugar.
2. **Fully structural interfaces (drop `: I`).** Rejected: requires synthesizing `InterfaceImpl` rows at emit and v-table bridging — a large, orthogonal effort (see ADR-0085 emit notes). Out of scope for this ADR.
3. **Excess-property errors (TypeScript fresh-literal check).** Rejected per product decision: width subtyping (extra members allowed) is the chosen behavior; no freshness distinction is made between literals assigned directly vs via a variable.
4. **Exact-shape match (no extra, no missing members).** Rejected: less ergonomic than width subtyping and inconsistent with G#'s data-class composition model.
