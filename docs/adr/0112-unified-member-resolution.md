# ADR-0112: Unified member resolution

- **Status**: Accepted
- **Date**: 2026-06-21
- **Phase**: Phase 5 — generics & dogfooded core
- **Closes**: User-type method groups cannot be converted to delegates
  (`Use(Box.Make)` → GS0158, `Use(Make)` → GS0125) even though the language
  server can resolve the same `shared`/instance members for hover/completion.
- **Related**: ADR-0053 (`shared` static members); ADR-0063 (overload sets);
  ADR-0051/0052 (properties/events); ADR-0110 (nested types); Issue #324 /
  #337 (method groups for free functions and CLR members)

## Context

The binder and the language server resolve members of user-defined G# types
through **separate, duplicated code paths**.

The language server resolves a member uniformly — it concatenates a type's
instance and static tables (`Properties.Concat(StaticProperties)`,
`Methods.Concat(StaticMethods)`, …) and walks the `BaseClass` chain. This is
copied in at least four places:

- `HoverComputer.LookupMemberOnStruct`
- `SemanticLookup.SemanticModel.LookupMember`
- `SemanticLookup.BuildModelUncached` struct-member mapping
- `CompletionComputer.AddStructInstanceMembers` / `AddStructStaticMembers`

plus an overload counter (`HoverComputer.CountOverloads`). Because the LS
enumerates `Methods`/`StaticMethods` directly, hover and completion succeed
for a user `shared`/instance method.

The binder, by contrast, uses fragmented, capability-gated logic:

- `ExpressionBinder.IsMethodGroupCandidateUsable` rejects every candidate that
  is `IsInstanceMethod || IsStatic || StaticOwnerType != null`, so only
  top-level free functions can become a bare-name method group.
- `ExpressionBinder.Access.BindUserTypeStaticMemberAccess` handles only static
  fields/properties — there is **no** static-method/method-group branch (the
  CLR sibling `TryBindClrMethodGroup` does have one).
- The `expr.M` user-struct instance branch in `BindAccessorStep` handles only
  fields/properties.
- `HasUserTypeStaticMember` does not recognize methods for the non-call form.

The result is a hover-vs-build divergence: the editor says a member exists and
is callable, but the compiler refuses to form a method group for it.

`class` and `struct` are both `StructSymbol` (distinguished by `IsClass`);
interfaces are `InterfaceSymbol` (with static-virtual members), enums are
`EnumSymbol`. No single canonical user-member lookup exists today.

## Decision

### A canonical, pure member-resolution layer

Introduce one canonical member-resolution layer in Core
(`src/Core/CodeAnalysis/Symbols/TypeMemberModel.cs`) that both the binder and
the language server consume. It is **pure**: it has no `BinderContext`
dependency and returns only existing `Symbol` instances
(`FunctionSymbol`/`FieldSymbol`/`PropertySymbol`/`EventSymbol`/nested type
symbols), so emit, overload resolution, and conversion are unaffected by the
layer itself. Because it is pure, the language server can call it directly.

Contract:

- `TypeMemberModel.LookupMember(TypeSymbol, name, query) : Symbol` — the single
  first-match member named `name`, honoring the LS priority order
  (property → field → event → method, instance and static concatenated),
  walking the `BaseClass` chain. This preserves existing hover/LS semantics
  exactly.
- `TypeMemberModel.GetMethods(TypeSymbol, name, query) : ImmutableArray<FunctionSymbol>` —
  the overload set named `name` (instance and/or static per the query),
  walking inheritance with signature-based dedup
  (`BoundScope.FunctionSignaturesEqual`).
- Kind helpers: `TryGetField`, `TryGetStaticField`, `TryGetProperty`,
  `TryGetStaticProperty`, `TryGetEvent`, `TryGetStaticEvent`.
- `EnumerateMembers(TypeSymbol, query) : IEnumerable<Symbol>` for completion.
- `MemberQuery` flags: `IncludeInstance`, `IncludeStatic`, `IncludeInherited`,
  and a kind mask.

Backends cover `StructSymbol` (class + struct), `InterfaceSymbol` (including
static-virtual members), and `EnumSymbol`. CLR/imported member reflection is
**out of scope**: it stays behind `MemberLookup`'s shape probes and is not
consolidated by this work, bounding the blast radius.

### Method-group semantics for user-type members (first consumer)

With the layer in place, the binder forms a `BoundMethodGroupExpression` for a
user-type method in each access form:

- `Type.M` (static): a `shared` method becomes a method group with a **null**
  receiver (single candidate carries its `FunctionTypeSymbol`; an overload set
  defers selection to `ConversionClassifier.BindUserMethodGroupConversion`).
- `expr.M` (instance): builds an instance method group whose **receiver is the
  bound `expr`**.
- bare `M` (implicit `this`/implicit shared): inside the declaring type, a bare
  name that resolves to an instance method becomes a method group captured
  against the implicit `this`; a `shared` method becomes a null-receiver group.

The `FunctionTypeSymbol` for the group is built from the same interned
parameter/return `TypeSymbol`s used everywhere else, so the
`ReferenceEquals`-based overload pick in `ConversionClassifier` keeps working.

### Emit

`MethodBodyEmitter.EmitMethodGroup` already handles both a null receiver
(`ldnull; ldftn`, static/free) and an instance receiver (box value types,
`ldvirtftn` for `open`/`override`), and already resolves the target `MethodDef`
from `cache.FunctionHandles` (free functions) then `cache.MethodHandles`
(user instance/static methods). The only required emit change is in
`SlotPlanner.ReceiverSpillCollector`: add a `VisitMethodGroupExpression`
override (mirroring the existing `VisitClrMethodGroupExpression` override) so an
instance group whose receiver is a non-addressable struct rvalue gets a spill
slot.

## Consequences

- The duplicated LS enumerations are deleted and routed through the canonical
  layer, removing a class of hover-vs-build divergences.
- The originally reported bug is fixed: a user class with
  `shared { func Make() … }` used as `Use(Box.Make)` and bare `Use(Make)`
  (and the instance equivalents) compiles and runs.
- Behavior parity for hover/completion and existing binder member access is a
  hard requirement; Phase-2 characterization tests gate the migrations.
- Full consolidation of CLR/imported member reflection into the same layer is
  deferred; the layer exposes a unified entry point but CLR resolution remains
  a `MemberLookup` backend.
