# ADR-0085: Default interface methods — implementation (supersedes ADR-0018)

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 3.B.4 follow-up (interfaces); unblocks ADR-0018 reopen criterion
- **Supersedes**: ADR-0018 (interface defaults — deferred). The deferral decision in ADR-0018 is reversed by this ADR; the deferral rationale (diamond complexity, data/behavior separation) is acknowledged but the implementation cost is now justified by concrete pull (issue #726 / parent #706: ADT-style sealed-hierarchy default behavior and binary-compatible interface evolution).
- **Related**: ADR-0017 (method virtuality), ADR-0019 (extension functions), ADR-0051 (interface properties), ADR-0078 (declaration-head grammar).

## Context

ADR-0018 deferred default interface methods (DIM) to "Phase 6 or later" and required a concrete user request to reopen the question. Issue #706 (and the Oats sweep that produced ADRs 0070–0084) surfaced two such requests:

- **Binary-compatible interface evolution.** Library authors who own an interface but not all its implementors need to add a method without breaking existing implementors. Extension functions (ADR-0019) cover *additive* methods but cannot give the *interface contract* a fallback that subtypes can choose to override (and call back into via the chain).
- **ADT default behavior on sealed interfaces.** Sealed-interface hierarchies (ADR-0078 `sealed interface`) often want a single shared implementation for a method that virtually every case implements identically. Forcing every variant to repeat the body is exactly the boilerplate ADR-0078 was added to avoid.

The CLR has supported DIM since .NET Core 3 / C# 8. G# targets `net10.0` (`global.json` pins SDK `10.0.300`), so the underlying runtime feature is universally available — there is no minimum-framework concession to make.

## Decision

GSharp interface declarations may carry **instance-virtual default method bodies**. The body lives on the interface; classes that implement the interface inherit it unless they explicitly `override` it.

### Surface

```gs
interface IShape {
    func Area() int32                     // abstract — implementor must provide
    func Describe() string {              // default — implementor inherits unless overridden
        return "shape with area $(Area())"
    }
}

class Square(Side int32) : IShape {
    func Area() int32 { return Side * Side }
    // Describe() inherited from IShape
}

class LabeledSquare(Side int32, Label string) : IShape {
    func Area() int32 { return Side * Side }
    override func Describe() string { return "$Label ($(Area()))" }
}
```

A method declared inside `interface { … }` is **abstract when the body is omitted** and a **default when the body is present**. The `default` keyword is **not** introduced — body-vs-no-body is the discriminator. This matches the parser's existing shape (a `FunctionDeclarationSyntax` with a non-null `Body`) and avoids a new contextual keyword.

### Conflict resolution (diamonds)

When a class implements two unrelated interfaces `I1` and `I2`, both of which provide a default body for the same `M`, and the class does **not** itself declare `M`:

- Diagnostic **GS0318** (error) at the class's identifier location:
  > Class 'C' inherits conflicting default implementations of method 'M' from interfaces 'I1' and 'I2'; declare an override on 'C' to disambiguate.

Disambiguation rule (Java-style): the implementer **must** declare its own `override func M(...) …` body. Inside that override, the implementer is free to call either base via fully-qualified extension-function syntax or any other in-language mechanism. **An `IFoo.Method(this)` / `base<IFoo>.Method()` syntax for calling a *specific* base default is intentionally not introduced in this PR** — see "Deferred work" below.

A class is *not* in conflict when:

- Only one of the two interfaces provides a default for `M` (the one default wins automatically — the abstract requirement on the other interface is satisfied by the same method).
- The class explicitly declares (or inherits from its base class) its own implementation of `M`.
- The two "conflicting" defaults are actually the *same* `FunctionSymbol` reaching the class via two paths (re-inheritance through interface extension).

### What is in scope

| Capability | In scope? | Rationale |
| --- | --- | --- |
| Instance default body (`func M() T { … }`) | ✅ | The headline DIM feature. |
| Diamond conflict diagnostic (GS0318) | ✅ | Java/C# precedent; safety net required to ship DIM. |
| Default body calls another interface method on `this` | ✅ | Trivially supported — bodies bind through the normal `BoundUserInstanceCallExpression` path. |
| Default body satisfies a *required* implementer | ✅ | Required for binary-compat evolution. |
| Implementer overrides a default | ✅ | Required for ADT-style customisation. |

### What is intentionally **deferred** (not in this PR)

| Capability | Deferred? | Rationale |
| --- | --- | --- |
| `static` interface members with bodies (DIM static-virtuals, C# 11) | Deferred | Static abstracts pull in generic-math-style constraint inference, a separate design surface (ADR-0021 variance / ADR-0020 generics interaction). The CLR feature is orthogonal; this PR keeps DIM minimal. |
| `private` interface helper methods (callable only from other default bodies on the same interface) | Deferred | A pure scoping/encapsulation refinement on top of the core feature. No user request observed yet. |
| `sealed override` of a default (preventing further override down the class chain) | Deferred | ADR-0017's `open` / non-`open` model already gives implementers a final slot by default; the additional `sealed override` shape is only meaningful for `open class` re-derivation, which is already a niche corner of ADR-0017. |
| Explicit-base default call syntax (`base<IFoo>.M()` or `IFoo.M(this)`) | Deferred | Not required to satisfy GS0318: the implementer can replicate the body inline. A dedicated syntax is more useful once we have at least one observed user request for "call default *and* augment it"; this PR's `override` semantics already cover "replace default entirely". |

A static interface member with a body, a `private` interface method, or any of the other deferred shapes is rejected at parse-time today (no modifiers are accepted on interface method declarations) and continues to be rejected after this PR. A follow-up issue tracks each deferred capability separately and can land independently.

### Diagnostics

| ID | Severity | Trigger |
| --- | --- | --- |
| **GS0318** | Error | A class inherits conflicting default implementations of the same method from two unrelated interfaces and does not declare an override. |
| **GS0319** | Error | An interface method that previously had a default body has been removed/abstract-ified in a way that leaves an implementer unable to satisfy the contract through inheritance alone (e.g. the implementer relied on an inherited default that is now abstract). Reserved for the diagnostic surface; emitted by the binder when a class's `Methods` set is empty for an `M` whose declaring interface has dropped its default. |
| **GS0320** | Error | A class implements an interface that has *neither* a default body for method `M` *nor* an inherited implementation in the class hierarchy, and the class does not declare `M` itself. (This is the "no default, no impl" anchor of GS0187; GS0187 stays as the *general* "method not implemented" channel and GS0320 fires only when the implementer would otherwise have been rescued by a default that the interface deliberately marked abstract.) |
| **GS0321** | Error | A `static` or `private` modifier appears on an interface method declaration in this version of GSharp (deferred per "Deferred work" above). The diagnostic names the offending modifier and points to this ADR. |

The pre-existing **GS0186** diagnostic ("Interface method may not have a body in this version of GSharp; see ADR-0018") is **removed** — the rule it enforced is reversed by this ADR. Any test that asserted GS0186 fired on an interface body is rewritten to assert the body is now accepted.

### Emit (CLR)

An interface is still emitted as `TypeAttributes.Interface | TypeAttributes.Abstract | TypeAttributes.Public`. Its method definitions differ depending on whether they carry a default:

- **Abstract method** (no body): `MethodAttributes.Public | HideBySig | Virtual | Abstract | NewSlot` and `bodyOffset = -1` (current behavior — unchanged).
- **Default method** (with body): `MethodAttributes.Public | HideBySig | Virtual | NewSlot` (NO `Abstract`) and a real `bodyOffset` produced by the normal `EmitFunction` body-emit pipeline. `MethodImplAttributes.IL | Managed` (no `Runtime`). This is exactly the CLR shape `csc` produces for a C# 8+ `interface I { void M() { … } }`.

Implementers (`class C : I`) get an `InterfaceImplementation` row exactly as today; the CLR's runtime dispatcher resolves to the class's override if present, otherwise to the interface default body. No `.override` directives need to be synthesized for the inherited-default case — the InterfaceImpl row plus name/signature match is sufficient.

The IL verifier (`ilverify` tool, restored at the worktree root) must pass on the resulting assemblies — DIM bodies use only ECMA-335-conforming shapes (`ldarg.0`, `callvirt` through the interface slot, etc.).

### Interpreter

The interpreter (`Evaluator.cs`) already runs `BoundUserInstanceCallExpression` against a `program.Functions` lookup keyed by `FunctionSymbol`. Interface default bodies are bound and registered in `functionBodies` the same way class instance method bodies are. The dispatch path in `EvaluateUserInstanceCallExpression` is enhanced so that when an interface method is dispatched against a runtime `StructValue` and no override is found in the class hierarchy, it falls back to the interface method symbol itself — which now has an entry in `program.Functions` when the interface declared a default body.

### Bound tree

DIM does **not** introduce a new `BoundNodeKind`. An interface default body is a `BoundBlockStatement` keyed by a `FunctionSymbol` whose `ReceiverType` is the `InterfaceSymbol`. The existing `BoundUserInstanceCallExpression` dispatch and the existing `BoundTreeRewriter` / `BoundTreeWalker` / `BoundNodePrinter` / `SpillSequenceSpiller` coverage all apply unchanged.

## Consequences

Positive:

- Library authors can evolve interfaces without breaking implementors (the original DIM use case).
- `sealed interface` ADT hierarchies can share a default `Describe()` / `Format()` / etc. without per-case boilerplate.
- The deferral language in ADR-0018 — "extension functions cover the additive case" — is preserved: extension functions remain the right choice when the method does **not** need a virtual fallback (`override` semantics in subtypes). DIM is the right choice when it does.
- Cross-language interop: a G# interface with a default body is a real CLR DIM. C# consumers see the default through any of the normal CLR dispatch shapes (`dynamic`, interface-typed reference, `Method` resolution through `Type.GetMethod`).

Negative:

- The diamond resolution rule is now part of the user-visible language. We mitigate by making the rule the *simplest* possible (Java-style "you must override to disambiguate"); the more powerful explicit-base call syntax is deferred until concrete demand exists.
- Library authors now have *two* ways to add a method to a contract — DIM and extension functions. Choosing between them requires understanding both. Docs (this ADR, the spec interface section, and `website/docs/guide/types-and-values.md`) call this out explicitly: extension functions for *additive non-virtual*, DIM for *virtual with a fallback*.

Neutral:

- The Phase 6 revisit criterion specified in ADR-0018 is satisfied; ADR-0085 is the revisit ADR.
- No changes to ADR-0019 (extension functions) or ADR-0078 (declaration-head). ADR-0017 (method virtuality) governs the `open` / `override` semantics that DIM defaults inherit.

## Alternatives considered

- **Require the `default` keyword on interface bodies** (Java surface). Rejected: the parser already disambiguates body-vs-no-body, the keyword would be a contextual keyword (adding a parse-table entry), and the C# 8+ surface (no `default` keyword needed) is the closer precedent for a CLR-targeting language.
- **Pick C# style "most-specific override wins" diamond rule.** Rejected: that rule is hard to teach, error-prone to apply, and depends on a notion of "specificity" that ADR-0018's deferral text already flagged as unwise to introduce early. The Java-style "always require an explicit override" rule is unambiguous at the call site and never silently picks a winner the user did not intend.
- **Ship `static abstract` interface members in the same PR.** Rejected: static-virtuals interact with generic constraints (ADR-0020 / ADR-0021) and would roughly double the design surface. Deferred for a dedicated ADR.
