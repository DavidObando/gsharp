# ADR-0090: Private interface helper methods

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 3.B.4 follow-up (interfaces); deferred-work item from ADR-0085.
- **Related**: ADR-0085 (DIM minimal-scope, supersedes ADR-0018), ADR-0089 (static-virtual interface members), ADR-0018 (interface defaults, historical), ADR-0017 (method virtuality), ADR-0014 (accessibility model). Issue #756 (this ADR), parent #706, sibling #755 (ADR-0089), #757 (explicit-base interface call — still deferred), #726 (ADR-0085 DIM).

## Context

ADR-0085 landed default-interface methods (DIM): an `interface` declaration may now carry instance method bodies that implementers inherit or override. ADR-0085 explicitly deferred two related capabilities:

- **`static`-virtual interface members** — landed in ADR-0089 (issue #755).
- **`private` interface helper methods** — this ADR (issue #756).

When an interface ships shared default implementations, those defaults grow shared helpers. The C# 8 design solves the encapsulation problem by allowing helper methods on the interface itself to be marked `private`, so they participate in the interface's compilation unit without leaking into the public surface. The CLR has supported `MethodAttributes.Private` on interface members since the same wave of changes that brought DIM, and the runtime correctly refuses external calls through the interface slot. G# already targets `net10.0` (`global.json` pins SDK `10.0.300`), so the runtime feature is universally available.

ADR-0085 currently catches `private` on interface members with **GS0321** (the "deferred modifier" anchor). This ADR replaces that part of GS0321 with first-class support; GS0321 remains for `open` / `override` modifiers on interface methods, which continue to be rejected.

## Decision

GSharp interfaces may declare instance methods marked **`private`**. A private interface method:

1. **MUST carry a body.** A `private` interface method without a body is a contradiction in terms: no implementer can satisfy the contract because no implementer is allowed to see the slot. The binder reports **GS0335** when the body is omitted.
2. **Is callable only from other members declared on the same interface declaration.** Calls from outside the interface (a class consuming the interface, a sibling top-level function, another interface) are rejected with **GS0334**.
3. **Is invisible to implementers.** An implementing class or struct cannot satisfy, override, or shadow a private interface helper. A class that declares a method whose signature matches a private interface helper on an implemented interface is rejected with **GS0336**. A class that *does not* declare such a method is **not** required to do so — private helpers do not contribute to the abstract-implementation contract that drives GS0187 / GS0320.
4. **Inherits the C# 8 emit shape.** The CLR's interface TypeDef carries the helper as `MethodAttributes.Private | HideBySig` (instance form). When combined with `static` (per ADR-0089), the helper is emitted as `MethodAttributes.Private | Static | HideBySig`. In **neither** case is the method `Virtual` or `Abstract` — private interface members are intentionally non-virtual and live in the interface TypeDef purely as a self-contained encapsulation tool.

### Surface

```gs
package GSharp.Samples.PrivateInterfaceHelpers

interface IShape {
    func Area() int32

    func Describe() string {
        return "shape with area $(Format(Area()))"
    }

    private func Format(value int32) string {
        return "value=$value"
    }
}

class Square(Side int32) : IShape {
    func Area() int32 { return Side * Side }
    // Format is invisible to Square — Describe() still works because its
    // body lives on the interface and resolves Format inside that scope.
}
```

Two things are happening here:

1. **`private func Format(...)`** lives on `IShape`. The parser accepts the `private` token in the same slot as `static` (both contextual to the interface body) and the binder routes the function symbol into a separate `InterfaceSymbol.PrivateMethods` bucket so the existing `InterfaceSymbol.Methods` set (which drives implementer-contract verification) is unaffected.
2. **`Describe()`** — a public default method on the same interface — freely calls `Format(...)`. The binder's call-site visibility check (`ExpressionBinder.Calls`) widens the candidate set with private helpers whenever the enclosing function is an instance or static method whose receiver / static-owner is the same `InterfaceSymbol`.

### Visibility model

The model is intentionally **the smallest possible**:

- `private` on an interface member means "this method is part of the interface's own implementation, not part of its contract." Sibling members of the same interface declaration may call it; nothing else may.
- The visibility boundary is the **interface declaration**, not the *interface family* (no special handling of nested interfaces, no special handling of derived interfaces). G# does not have interface inheritance today (the v1 `interface : interface` extension is on a separate roadmap), so the unit-of-encapsulation question is trivial: it is the single declaration.
- An implementer cannot widen, narrow, override, or shadow the helper. The implementer's same-name member is rejected outright (GS0336) — we do **not** silently treat the implementer's member as a sibling of the interface helper.
- The interface's public default methods are unaffected: they continue to carry `MethodAttributes.Public | Virtual | NewSlot | HideBySig` and inherit / override per ADR-0085's rules.

### Why `private` only — not `internal` / `protected`

`internal` and `protected` are **deferred follow-ups** and not part of this PR:

- **`internal` interface members** would require an `AssemblyVisibility` mapping at every interface-call site (the CLR's `MethodAttributes.Assembly` is a package-scope visibility). The G# accessibility model already treats "package" and "assembly" as synonyms (ADR-0014), but the binder check would need to know "this call site lives in the same package as the interface declaration." That is a real cross-package visibility check that does not yet exist anywhere else in the interface code path. We can land it in a follow-up issue once we observe demand — the most common use case for `internal` helpers is also covered by writing a public default that delegates to a top-level `internal func`.
- **`protected` interface members** are a C# 8 surface that has **no equivalent in any G# concept today**. Protected methods presume an inheritance chain; G# interfaces have no inheritance chain. The CLR shape `MethodAttributes.Family` on an interface method is meaningless for the v1 G# binder. We reject `protected` with GS0321 (the deferred-modifier anchor) and revisit when interface-on-interface extension lands.

This PR keeps the surface to **`private` instance** and **`private static`** (combined with ADR-0089's static-virtual machinery). Both are sufficient to cover the headline use case: encapsulated helpers for shared default-method bodies.

### Diagnostics

| ID | Severity | Trigger |
| --- | --- | --- |
| **GS0334** | Error | Code outside an interface declaration tries to call a `private` member of that interface — e.g. a method on an unrelated interface, a class method, or a top-level `func`. The diagnostic names the call site, the helper, and the owning interface. |
| **GS0335** | Error | A `private` interface method is declared without a body. The diagnostic names the helper and points to this ADR. |
| **GS0336** | Error | An implementing class or struct declares a method whose name and signature match a `private` helper on one of its implemented interfaces. The diagnostic names the implementer, the interface, and the helper. |
| **GS0337** | Error | A `private` modifier appears on an interface **property** or **event** declaration (those shapes are not in scope for this ADR; ADR-0051 / ADR-0052 own them). The diagnostic names the offending member and points to this ADR. |

**GS0321** keeps fire for `open` and `override` on interface methods (still deferred); the `private` branch is **removed** because `private` is now valid. Any GS0321 test asserting `private` was rejected is rewritten to assert the new positive shape (binder accepts the declaration).

### Emit (CLR)

A private interface member is emitted on the interface TypeDef with these flags:

- **Instance** (`private func M(...) T { ... }`): `MethodAttributes.Private | HideBySig`. **No** `Virtual`, **no** `NewSlot`, **no** `Abstract`. The method has a real RVA and a real body (the `EmitFunction` pipeline plugs in IL the same way it does for any class instance method). `MethodImplAttributes.IL | Managed` (no `Runtime`). Calls inside the interface's default methods are emitted with plain `call` (not `callvirt`) targeting the helper's MethodDef directly — the method is non-virtual, so virtual dispatch is unnecessary and would only add a runtime null check that cannot fail (the `this` arg comes from the enclosing default body, where `this` is provably non-null per the CLR's contract for instance dispatch).
- **Static** (`private static func M(...) T { ... }` — combined with ADR-0089's static-virtual machinery): `MethodAttributes.Private | Static | HideBySig`. The static-virtual flag set (`Virtual | Abstract | NewSlot`) is **not** applied because a private helper has no public contract — implementers do not see it, so there is no slot to override. The body is emitted by `EmitFunction` and call sites use a plain `call` to the MethodDef.

This is exactly the shape `csc` produces for a C# 8+ `interface I { private void M() { … } }` (instance) and `interface I { private static void M() { … } }` (static, C# 8+). The CLR's `ilverify` pass accepts the shape without any waiver.

The MethodDef is **not** added to the InterfaceImpl resolution table on any implementer: there is no slot for implementers to fill. Class `: I` continues to emit one `InterfaceImplementation` row per declared interface as today; only the public method slots on the interface require name+signature pairing on the implementer.

### Interpreter

`Evaluator.cs` already runs `BoundUserInstanceCallExpression` against `program.Functions` keyed by `FunctionSymbol`. Private interface methods are registered in `functionBodies` identically to public default-interface methods. The interpreter's existing virtual-dispatch fallback (which walks the receiver's class chain looking for an override before falling back to the interface method) does **not** apply to private helpers: a call to a private helper is statically bound through the interface receiver, and no implementer is allowed to declare a same-name method (GS0336 fires at bind time). The interpreter therefore needs no behavior change beyond making sure the helper's body is in `program.Functions` — which the existing DIM pipeline already does because the helper carries a non-null `Body`.

### Bound tree

This ADR does **not** introduce a new `BoundNodeKind`. A private interface helper is a `FunctionSymbol` whose `ReceiverType` is the owning `InterfaceSymbol` (or whose `StaticOwnerType` is, for the `private static` form). Calls go through the existing `BoundUserInstanceCallExpression` (instance) or `BoundUserStaticCallExpression` (static) paths. The `BoundTreeRewriter` / `BoundTreeWalker` / `BoundNodePrinter` / `SpillSequenceSpiller` coverage is unchanged.

### Interaction with ADR-0085 (DIM) and ADR-0089 (static-virtual)

- **ADR-0085** is the parent. Private interface helpers presume default-interface methods exist (there must be something on the interface that can call them). The visibility rule explicitly extends ADR-0085's "default body lives on the interface" model: the body is on the interface, but the public surface excludes the helper.
- **ADR-0089** is orthogonal. `private static func` combined the two: a static-virtual interface member's default body may call a `private static` helper on the same interface; the helper itself is **not** static-virtual (it is plain `Static | Private`). Generic dispatch through type-parameter constraints (`T.M(...)`) is **not** allowed for private helpers — the constraint-based dispatch path goes through the interface's public static-virtual contract, which the helper is not part of.
- **GS0321** continues to fire for `open` and `override` on interface methods. The `private` branch of GS0321 is removed.

## Consequences

Positive:

- Library authors writing default-interface methods can extract shared helpers without polluting the interface's public surface.
- The CLR shape matches C# 8 exactly — G# interfaces remain bit-compatible at the metadata level with `csc`-produced interfaces of the same shape.
- The deferral language in ADR-0085 is honored: every deferred capability ("static-virtual", "private helper", "explicit base call") is being lifted on an ADR-per-feature cadence as concrete pull arrives.

Negative:

- The implementer-visibility rule is stricter than C#'s: G# rejects a same-name implementer method outright (GS0336) instead of letting the implementer's method coexist as a separate slot. The rationale is that the implementer cannot intend to "override" the helper (they cannot see it), so the more likely intent is "they did not realize the helper exists and accidentally clashed with it." A diagnostic at bind time is friendlier than the silent CLR behavior (the implementer's method works on the class, but the interface's default body still calls the interface's own helper — a confusing dual-resolution that has bitten C# users).

Neutral:

- No new `BoundNodeKind`; no new emit machinery beyond a one-line accessibility-flag tweak; the interpreter is unchanged.
- `internal` / `protected` interface members remain deferred. The deferral note in ADR-0085 (and this ADR) tracks them as follow-up issues, not silent gaps.

## Alternatives considered

- **Match C# verbatim: silently allow same-name implementer methods.** Rejected. The C# behavior produces two unrelated methods (an interface helper that is never visible to the implementer, and an implementer method that is never called by the interface's default body) — a foot-gun. G# diagnoses the conflict explicitly (GS0336); the user can rename either method to resolve it.
- **Make `private` an instance-only modifier in this PR; leave `private static` to a follow-up.** Rejected. ADR-0089 already accepts `static` on interface methods. The combined `private static` requires only one extra branch in the emit attribute-set computation (`Static | Private` instead of `Public | Static | Virtual | …`); deferring the combination would create a "neither / both" mismatch that is more confusing than just landing both at once.
- **Land `internal` / `protected` in the same PR.** Rejected. `internal` requires a real cross-package visibility check that does not yet exist on the interface code path; `protected` has no semantic in v1 G#. The deferral keeps this PR focused on the headline private-helper use case.
- **Continue to reject `private` with GS0321 and have users write a top-level `private func` outside the interface.** Rejected. A top-level helper cannot be called by the interface's default body without the implementer being able to see it too (in the implementer's package). The whole point of a private interface helper is that the helper's reachability is the interface declaration, not the package; the top-level workaround does not preserve that boundary.
