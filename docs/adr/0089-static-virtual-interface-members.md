# ADR-0089: Static-virtual interface members

- **Status**: Accepted (revised by issue #865)
- **Date**: 2026-06-12 (revised 2026-06-16)
- **Phase**: Phase 3.B.4 follow-up (interfaces); deferred-work item from ADR-0085.
- **Related**: ADR-0085 (DIM minimal-scope), ADR-0018 (interface defaults), ADR-0020 (generics scope), ADR-0017 (method virtuality), ADR-0053 (static members — `shared` block), ADR-0078 (declaration head), ADR-0087 (reified generics emit audit), ADR-0088 (constraint-aware overload resolution), ADR-0090 (private interface helpers). Issue #755 (this ADR), issue #865 (this revision), parent #706, sibling #756 (private interface helpers), #757 (explicit-base interface call — deferred), #726 (ADR-0085 DIM).

## Revision (issue #865)

This ADR originally introduced a `static func` modifier on interface members to declare static-virtual slots. Issue #865 reverses that surface decision: **static-virtual interface members are now declared inside a `shared { … }` block on the interface**, identical to how classes and structs already group their static members (ADR-0053). This removes the lone inconsistency where interfaces used a `static` modifier while every other type used a `shared` block.

The change is a **breaking change** and is purely front-end (parser surface): the binder routing, CLR emit shape, and interpreter dispatch are unchanged.

- `static func M(...)` on an interface → `shared { func M(...) }`. A body-less `func` inside the interface `shared` block is the **abstract** static slot; a `func` with a body is the **default** static slot (the body-vs-no-body discriminator is unchanged).
- `private static func M(...)` (ADR-0090) → `shared { private func M(...) }`. Instance `private func` helpers stay directly in the interface body (unchanged).
- `static` is **no longer a contextual keyword** anywhere in the language — it reverts to an ordinary identifier. The removed `static func` form on an interface now falls through to the generic "unexpected token" parser error (GS0005); no dedicated migration diagnostic is emitted.
- Only `func` members are permitted inside an interface `shared` block. A non-`func` member (interface static state) is rejected with GS0330. *(Superseded by issue #1019, which lifted the `prop` rejection, and issue #1030, which lifted the `var`/`let`/`const` state rejection for non-generic and generic interfaces — see the further-revision notes below.)*

The body of this ADR below has been updated to reflect the `shared`-block surface. Sections describing CLR metadata, dispatch, the interpreter, and the bound tree are unaffected by the revision.

**Further revision (issue #881):** an abstract (body-less) static slot inside the interface `shared { … }` block now requires a terminating `;` — the universal no-body marker for funcs (`func Add(a T, b T) T;`). A default slot with a `{ … }` body is unchanged. See ADR-0085's "Revision (issue #881)" section.

**Further revision (issue #1019): static-virtual interface *properties*.** The original ADR deferred static-virtual properties on interfaces (see the "intentionally deferred" table). Issue #1019 lifts that deferral for the **abstract** form: an interface `shared { … }` block may now declare a `prop` member — `prop Name T { get; }`, `prop Name T { get; set }`, or the bare `prop Name T;` (get/set) — modelled as static-virtual `get_Name`/`set_Name` accessor *methods* (the exact `Static | Virtual | Abstract` slot shape used for static-virtual methods) plus a CLR `Property` row. The implementer satisfies the slot with a matching static property in its own `shared { … }` block, paired to the interface accessor slots via `MethodImpl` rows; a generic method constrained by the interface reads the property through `T.Name`, lowered to the same `constrained. !!T  call <iface>::get_Name()` sequence as a static-virtual method call. This is the missing piece for the .NET generic-data / `static abstract` property pattern (e.g. `static abstract int SizeInBytes { get; }`). Two narrower cases remain deferred: a **default-bodied** static interface property (accessor bodies) is rejected with **GS0396** (interface properties are abstract slots only in this release — expose a default via a static `func`), and interface static **state** (storage — `var` / `let` / `const` fields inside the interface `shared` block) is still rejected with **GS0330**. An implementer that omits a required static-virtual interface property is reported with **GS0397**.

**Further revision (issue #1030): interface static *state* and default-bodied static-virtual interface *properties*.** Issue #1030 lifts the two cases that #1019 deferred. (1) **Interface static state** — an interface `shared { … }` block may now declare `var` / `let` / `const` fields, on **both non-generic and generic** interfaces. These are emitted as real CLR `Static` FieldDef rows on the interface TypeDef (CLR interfaces may own static fields); `const` fields are emitted as `Static | Literal | HasDefault` literals with a `Constant` row and their reads are inlined; non-`const` field initializers run in a synthesized interface `.cctor`. The fields are read/written by bare name inside the interface's own static members (static methods and default-bodied static property accessors) and by qualified `IName.Field` (or `IBox[int32].Field` for a generic interface) from anywhere; compound assignment (`+=` / `-=`) is supported. On a **generic** interface each closed construction owns independent storage: access sites reference the field through a `TypeSpec` for the construction (`IBox[int32]` and `IBox[string]` are distinct), exactly as for static fields on constructed generic structs/classes, so the result matches CLR per-construction static-field semantics. The storage is shared interface state (not per-implementer). **GS0330** now only fires for an `event` member inside an interface `shared` block. (2) **Default-bodied static-virtual interface properties** — `prop X T { get { … } }` inside an interface `shared` block now emits non-abstract `Static | Virtual` accessor slots *with* IL bodies plus the `Property` row; implementers may override but are not required to, and `T.X` constraint dispatch falls back to the interface default. **GS0396 is retired** (no longer raised).


## Context

ADR-0085 landed instance-virtual default-interface methods (DIM) and explicitly deferred *static* interface members ("static abstracts", C# 11). Issue #755 asks for that follow-up. The motivating use case is the .NET generic-math / generic-parser / generic-builder pattern: `INumber<T>`, `IParsable<T>`, `IAdditionOperators<TLeft, TRight, TResult>`, and the dozens of sibling interfaces in `System.Numerics`. These interfaces are how the .NET runtime expresses "type-classes by another name" — a constraint that requires the type argument itself to provide a static operation, dispatched through a generic constraint at the call site.

The CLR feature is universally available (G# targets `net10.0`, `global.json` pins SDK 10.0.300). The ECMA-335 changes that introduced static-virtual interface members are surfaced as the combination `MethodAttributes.Static | Virtual | Abstract` on the interface's `MethodDef` (II.22.26) and a `MethodImpl` row on the implementer (II.22.27) whose body method is `Static | NewSlot`. The call-site shape uses the `constrained.` prefix (II.4.2 / III.2.1) against the type parameter's `TypeSpec` followed by `call` (not `callvirt`) at the interface's `MemberRef`.

This ADR fills the gap.

## Decision

GSharp interfaces may declare **static methods** that participate in generic dispatch the same way instance methods participate today.

### Surface

```gs
package GSharp.Samples.StaticVirtualInterfaces

sealed interface IAdd[T] {
    shared {
        func Add(a T, b T) T;
        func Zero() T {
            return Add(default(T), default(T))
        }
    }
}

struct Int32Adder : IAdd[Int32Adder] {
    var Value int32

    shared {
        func Add(a Int32Adder, b Int32Adder) Int32Adder {
            return Int32Adder { Value = a.Value + b.Value }
        }
    }
}

func [T IAdd[T]] Sum(xs sequence[T]) T {
    var acc = T.Zero()
    for x in xs {
        acc = T.Add(acc, x)
    }
    return acc
}
```

Three things are happening here:

1. **`func` inside an interface `shared { … }` block** — abstract when the body is omitted (the implementer MUST provide), default when the body is present (the implementer MAY override). Mirrors ADR-0085's body-vs-no-body discrimination for instance DIM, reusing the `shared` grouping classes/structs already use (ADR-0053). A body-less `func` is legal here precisely because it denotes an abstract slot — the one place a `shared` `func` may omit its body.
2. **`T.Method(args)` inside a generic** — the binder routes the call to a new `BoundConstrainedStaticCallExpression` node when the receiver name resolves to a type parameter whose interface constraint declares a matching static method.
3. **`shared { func … }` on the implementer** — the implementer's static method lives in the conventional ADR-0053 shared block; the binder threads it into the interface contract automatically by name + signature match. The interface and the implementer now use the **same** `shared`-block grouping.

The constraint syntax accepts a generic type-argument list after the interface name (the "curiously-recurring" `[T IAdd[T]]` is the canonical generic-math shape). This is a new parser shape — see "Constraint grammar" below.

### Static-virtual identity (`func` / `prop`) vs. shared static *state* (fields)

There are two distinct concepts here. **Static-virtual identity** — a per-implementer operation or constant dispatched through a generic constraint — is expressed with a `func` or a `prop` (issue #1019): `prop X T { get; }` implemented by each type's `shared { prop X T { get { … } } }`. **Shared static state** — a single storage location owned by the interface itself, not the implementer — is a `var` / `let` / `const` field (issue #1030). The latter is *not* per-implementer: every reader sees the same field on the interface TypeDef. CLR interfaces may own static fields, so interface static state maps directly to `Static` FieldDef rows (with a synthesized `.cctor` for initializers and `const` literals inlined). This works on both non-generic and generic interfaces; on a generic interface each closed construction (`IBox[int32]` vs `IBox[string]`) owns independent storage via `TypeSpec`-parented field references at every access site, matching CLR per-construction static-field semantics. The `event` member kind inside an interface `shared { … }` block is still rejected with GS0330 (see "Diagnostics").

### Constraint grammar

The grammar for a type-parameter constraint is extended to allow an optional generic type-argument list after the interface name:

```
TypeParameter := [ VarianceModifier ] Identifier [ Constraint ]
Constraint    := Identifier [ '[' TypeArgumentList ']' ]
```

The constraint identifier remains a single token (matching the existing shape from ADR-0020 §4 / Phase 4.2b). The new optional `[T1, T2]` suffix is parsed by the same code path used for ordinary type-clause type arguments. Backwards compatibility is preserved: every existing constraint (`T any`, `T comparable`, `T ISomeSealedInterface`) parses identically.

Binder behavior:

- `T IAdd[T]` resolves the constraint as `Construct(IAdd, [T])` and stores the closed `InterfaceSymbol` on `TypeParameterSymbol.InterfaceConstraint`.
- The existing GS0153 sealed-constraint check is **relaxed** for an interface that declares at least one static-virtual member. The original rationale ("an open interface could be implemented by unknown future types, defeating the binder") is irrelevant here: the constraint *forces* the type argument to satisfy the static-virtual contract at the binder level, regardless of how many implementors live in any package. For purely-instance interfaces the sealed-constraint check is unchanged — an instance interface without `sealed` still trips GS0153.

### Abstract vs. default static methods

```gs
interface IFoo[T] {
    shared {
        func RequiredOp(a T, b T) T        // abstract — implementer MUST provide
        func WithDefault() T {              // default — implementer MAY override
            return default(T)
        }
    }
}
```

Body-vs-no-body is the discriminator. No new `default` keyword is introduced (consistent with ADR-0085's rationale).

### Implementer shape

The implementer declares a matching static method inside a `shared { }` block (ADR-0053):

```gs
struct Impl : IFoo[Impl] {
    shared {
        func RequiredOp(a Impl, b Impl) Impl { … }
    }
}
```

Signature match: same name, same arity, same parameter types (after substituting the interface's type arguments), same return type. If the implementer omits a required (abstract) static, the binder emits **GS0331**. If the implementer declares a *non*-static method whose name collides with a static-virtual slot, the binder emits **GS0332** ("the slot is static; the implementer's method must be static").

### Dispatch — `T.Method(args)`

Inside a generic function or method body, a call of the form `T.Method(args)` where `T` is a type parameter whose `InterfaceConstraint` declares a matching static method binds to a new bound node, `BoundConstrainedStaticCallExpression`:

- `TypeParameter` — the receiver `TypeParameterSymbol`.
- `InterfaceMethod` — the `FunctionSymbol` on the constraint interface that the call dispatches to.
- `Arguments` — bound, type-converted argument expressions.
- `Type` — the substituted return type (interface type arguments substituted through to the receiver type parameter where applicable).

If the receiver name resolves to a type parameter but no matching static method exists on the interface constraint, the binder emits **GS0333** ("type 'T' has no static member 'Method' through its interface constraint").

This bound node is preserved through lowering (it is not an "instance call" — there is no `this`) and is lowered to a CLR `constrained.` + `call` pair at emit time. The interpreter handles it via a new dispatch helper that looks up the implementer's static method at run time.

### CLR metadata

#### Interface `MethodDef`

An abstract static-virtual interface member emits as:

```
MethodAttributes = Public | HideBySig | Static | Virtual | Abstract | NewSlot
MethodImplAttributes = IL | Managed
bodyOffset = -1
```

A default static-virtual interface member emits as:

```
MethodAttributes = Public | HideBySig | Static | Virtual | NewSlot
MethodImplAttributes = IL | Managed
bodyOffset = <real-offset>
```

Both shapes match the C# compiler's output for `interface I { static abstract T Op(T x); }` and `interface I { static virtual T WithDefault() => default; }` respectively. The ECMA reference is II.15.4.2.4 ("static methods on interfaces") plus II.22.26 (MethodDef table) — the `Static | Virtual | Abstract` triple is the canonical encoding the CLR's interface resolver looks for.

#### Implementer `MethodDef` + `MethodImpl`

The implementer's matching static method is emitted as:

```
MethodAttributes = Public | HideBySig | Static
MethodImplAttributes = IL | Managed
bodyOffset = <real-offset>
```

It is **not** marked `Virtual` (CLR static methods don't have vtable slots). The link between this method and the interface slot it satisfies is expressed as a `MethodImpl` row (II.22.27): `MethodImpl.Class = <implementer TypeDef>`, `MethodImpl.MethodBody = <implementer's static method>`, `MethodImpl.MethodDeclaration = <interface's static-virtual method>`. The runtime resolves a `constrained. T  call I::M(args)` instruction to this `MethodImpl` row by looking up the type's `MethodImpl` table at run-time generic-dispatch time.

#### Call site

```
ldarg.0                                  // a
ldarg.1                                  // b
constrained. !!T                         // typespec for the method type-parameter
call !!T class IAdd`1<!!T>::Add(!!0, !!0)
```

The `constrained.` prefix carries a `TypeSpec` referencing the type parameter (encoded as `MVAR(idx)` when the call's enclosing function is generic, `VAR(idx)` when the type parameter is type-bound). The `call` (not `callvirt`) opcode is mandatory — ECMA-335 III.2.1 specifies that `call` is the resolved-at-typecheck-time opcode and that `constrained.` requires it. The MemberRef parent is a TypeSpec built from the closed interface (substituting any of the interface's own type arguments with the substitution active at the call site).

### Interpreter

The interpreter mirrors the emit path:

- For each interface with static-virtual members, the evaluator builds a `Dictionary<(implementer struct symbol, interface static FunctionSymbol), FunctionSymbol>` keyed by `(impl, ifaceSlot) → implMethod` at program-load time, by walking each implementer struct's `Interfaces` and `StaticMethods` and matching by signature.
- A `BoundConstrainedStaticCallExpression` looks up the type parameter's runtime substitution from the current call frame's `TypeArgumentSubstitutions`, finds the matching implementer struct, and calls the resolved implementer static through the existing `EvaluateCallExpression` path.

This is parity with the runtime CLR semantics — `constrained. T call IFace::M` resolves to the type's static method.

### Bound tree

A new bound-tree shape, `BoundConstrainedStaticCallExpression`, is introduced.

- `BoundNodeKind.ConstrainedStaticCallExpression` is added to the enum.
- `BoundTreeRewriter`, `BoundTreeWalker`, `BoundNodePrinter`, and `SpillSequenceSpiller` all gain a case.
- `BoundNodeKindExhaustivenessTests` allowlists are updated.
- `MethodBodyEmitter.Expressions.cs`'s switch routes to a new `EmitConstrainedStaticCall` helper.

### Diagnostics

| ID | Severity | Trigger |
| --- | --- | --- |
| **GS0330** | Error | A non-`func`, non-`prop`, non-field member (`event`) appears inside an interface `shared { … }` block. Interface static `var`/`let`/`const` state is accepted on both non-generic and generic interfaces (issue #1030). The diagnostic names the owning interface and points to this ADR. |
| **GS0331** | Error | A class/struct claims to implement an interface but does not declare a `shared { func … }` member that matches a required (abstract) static-virtual slot on the interface. Names the missing slot and the owning interface. |
| **GS0332** | Error | A class/struct claims to implement an interface and declares an *instance* method whose name matches a static-virtual slot on the interface (the implementer's method must itself be static). |
| **GS0333** | Error | A `T.M(args)` call references a member name that does not exist as a static-virtual on `T`'s interface constraint. Names the type parameter, the constraint interface, and the missing member. |
| **GS0396** | Error | (Issue #1019; **retired by issue #1030**) Formerly rejected a static-virtual interface `prop` with an accessor *body*. Default-bodied static-virtual interface properties are now supported (non-abstract `Static | Virtual` accessor slots with bodies), so GS0396 is no longer raised. |
| **GS0397** | Error | (Issue #1019) A class/struct claims to implement an interface but does not declare a matching static property (same name, type, and required accessors) for a static-virtual interface property slot. Names the missing slot and the owning interface. |

GS0321 (ADR-0085's "deferred modifier on interface method" diagnostic) no longer references `static` in any form — `static` is no longer a modifier (issue #865). It continues to fire for `open` / `override` on interface methods. The removed `static func` interface form now produces the generic GS0005 ("unexpected token") parser error rather than a dedicated diagnostic.

### What is in scope

| Capability | In scope? | Rationale |
| --- | --- | --- |
| Abstract `func` in interface `shared` block | ✅ | The headline feature. |
| Default-bodied `func` in interface `shared` block | ✅ | Symmetric with ADR-0085's instance default — required for "shared identity element" patterns (`Zero`, `One`). |
| Generic constraint `[T IAdd[T]]` with curiously-recurring generic args | ✅ | The canonical generic-math shape requires this. |
| `T.Method(args)` dispatch inside a generic | ✅ | The only way the feature is useful. |
| CLR `constrained. T call I::M` emission | ✅ | ECMA-335-conforming and matches C# 11's output. |
| Implementer declared via existing `shared { … }` block | ✅ | No new declaration shape needed; reuses ADR-0053. The interface side now uses the same grouping (issue #865). |
| Private static helpers via `shared { private func … }` | ✅ | Landed via ADR-0090; declared inside the interface `shared` block (issue #865). |
| Cross-language interop with C# producers | ✅ — emit side | A C# consumer can implement a G#-declared static-virtual interface (the emitted metadata is standard ECMA shape). |
| Cross-language interop with C# consumers | ✅ — emit + import | A G# consumer can use a C#-defined interface with static abstracts as a constraint, dispatching `T.Method(args)` to a G# or imported implementer. |
| Abstract static-virtual *property* in interface `shared` block (`prop X T { get; }` / `{ get; set }` / bare `prop X T;`) | ✅ (issue #1019) | Modelled as static-virtual `get_`/`set_` accessor methods plus a `Property` row; required for the .NET `static abstract … { get; }` generic-data pattern. |
| Default-bodied static-virtual interface property (`shared { prop X T { get { … } } }`) | ✅ (issue #1030) | Emitted as non-abstract `Static | Virtual` accessor slots with real IL bodies; implementers may override but are not required to. |
| Interface static **state** — non-generic `var`/`let`/`const` fields in the interface `shared` block | ✅ (issue #1030) | Emitted as real CLR `Static` FieldDef rows on the interface TypeDef (`const` → `Static | Literal` + `Constant` row); initializers run in a synthesized interface `.cctor`; read/write by bare name (inside interface members) or qualified `IName.Field`. |
| Interpreter parity | ✅ | Required by the acceptance criteria. |

### What is intentionally **deferred**

| Capability | Deferred? | Rationale |
| --- | --- | --- |
| Explicit-base call for a static-virtual default (`base[IFoo].M()` for statics) | Deferred (issue #757) | Same justification as ADR-0085: not required to ship the feature; symmetric with the instance-DIM deferral. |
| Constraint dispatch of a default-bodied static `func`/state on a **generic** interface (`U.Bump()` where `U : IBox[int32]`) | Deferred (pre-existing, orthogonal to #1030) | A generic interface's *default static method* has no emitted handle for constraint-dispatch (`InvalidOperationException: … has no emitted handle`). This is independent of static **state** — qualified `IBox[int32].Field` access and per-construction storage are fully supported; only constraint-dispatched generic default static *methods* remain unimplemented. |

Interface static `var`/`let`/`const` state on **both non-generic and generic** interfaces, default-bodied static-virtual `prop` members, and compound assignment (`+=` / `-=`) on interface static fields are all accepted (issue #1030). On a generic interface, each closed construction (`IBox[int32]` vs `IBox[string]`) owns independent static storage via `TypeSpec`-parented field references, matching CLR semantics. The remaining rejection (`GS0330`) is reserved for an `event` member inside the interface `shared` block.

## CLR / ECMA references

- ECMA-335 II.15.4.2.4 — static methods on interfaces and their dispatch shape.
- ECMA-335 II.22.26 — MethodDef table and the `MethodAttributes` triple `Static | Virtual | Abstract`.
- ECMA-335 II.22.27 — MethodImpl table (Class, MethodBody, MethodDeclaration) used to associate the implementer's static body with the interface's static-virtual slot.
- ECMA-335 III.2.1 — `constrained.` prefix and its `call` opcode requirement.
- C# language reference, "Static abstract members in interfaces" — the closest analogue to G#'s surface (terminology only; the ADR does not depend on the C# spec).

## Consequences

Positive:

- Generic-math, generic-parser, and generic-builder patterns become expressible in G#.
- Cross-language: a G# generic-math implementer can satisfy a C# `INumber<T>` (and vice versa).
- The bound-tree shape (a dedicated `BoundConstrainedStaticCallExpression`) keeps the dispatch concern localized; emit and interpreter both have a single small switch to extend.
- The implementer shape (existing `shared { }` block) reuses ADR-0053 verbatim; no new declaration grammar.

Negative:

- The constraint grammar `[T IAdd[T]]` adds a new lookahead concern to `ParseTypeParameter` (the closing `]` of the constraint's type-argument list must not be mistaken for the closing `]` of the surrounding type-parameter list). The parser uses bracket counting in the same shape as `ParseTypeArgumentList`, so the change is mechanical.
- `FunctionSymbol.StaticOwnerType` is widened from `StructSymbol` to `TypeSymbol` so it can carry the owning `InterfaceSymbol` when the function is an interface static-virtual. All seven call sites in `src/` cast back to `StructSymbol` as needed — see the corresponding edits.

Neutral:

- The CLR shape is standard. `ilverify` accepts the emitted assemblies; runtime dispatch is the standard `constrained. … call` shape.
- Interpreter parity follows from the same signature-match dictionary used for instance dispatch.

## Alternatives considered

- **Require explicit `: interface IFoo` declaration of the static implementation on the struct/class (instead of treating an existing `shared { func … }` as the implementation).** Rejected — it duplicates the per-class declaration surface for no semantic gain, and the natural shape of a struct that implements `IAdd[T]` is to host the `Add` method statically in its shared block anyway.
- **Reuse `BoundUserStaticCallExpression` (no new bound-tree node) by encoding the type-parameter receiver as a synthesized expression.** Rejected — the dispatch *target* is the interface slot, not a concrete static; the resolved method is not knowable until the type argument is substituted. A dedicated bound-tree node keeps the metadata clean and avoids overloading the regular-static path with a special-case "if the receiver is a TypeParameterSymbol, do something different" branch.
- **Lower static-virtuals to instance defaults on a synthesized `IAddCompanion[T]` object.** Rejected — it does not interoperate with C# producers/consumers (the .NET BCL uses the standard static-virtual encoding), defeats one of the headline use cases (generic math through `INumber<T>`), and does not satisfy the ECMA-335 dispatch shape.
- **Pull in generic constraint inference (`where T : IComparable<T>, IEquatable<T>, …` multi-constraint clauses).** Rejected for scope — a single interface constraint per type parameter is already the existing G# surface (ADR-0020 §4) and is sufficient for the headline use cases. Multi-constraint can land as a follow-up without disturbing the dispatch path.
