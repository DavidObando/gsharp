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

## Addendum — P0 enabler additions

The P0 enabler PR (`feat(symbols): TypeMemberModel P0`) extended the canonical
layer with purely additive capabilities that the later consumer-migration PRs
depend on. No existing behavior, ordering, or signatures changed; the parity
characterization tests remain green.

- **Declaring-type field lookup.** Added
  `TypeMemberModel.TryGetFieldIncludingInherited(TypeSymbol, string, MemberQuery,
  out FieldSymbol, out StructSymbol declaringType)`. It mirrors
  `StructSymbol.TryGetFieldIncludingInherited` (this-first base-chain walk) but
  lives behind the canonical layer and honors the `MemberQuery` axes
  (instance-before-static at each level, inherited toggle, `Field` kind). The
  binder needs the declaring `StructSymbol` to build
  `BoundFieldAccessExpression`. The original `TryGetField` is unchanged.

- **Interface and enum enumeration.** `EnumerateMembers` now handles
  `InterfaceSymbol` and `EnumSymbol` in addition to `StructSymbol`. Interface
  enumeration surfaces instance properties/events/methods plus static methods
  per the query/kinds (mirroring `LookupMember`/`GetMethods`). Enum enumeration
  surfaces enum members as static fields (mirroring the enum path in
  `LookupMember`). The existing `StructSymbol` enumeration order/behavior is
  preserved exactly (extracted unchanged into `EnumerateStructMembers`).

- **Property-lookup consolidation.**
  `MemberLookup.TryGetPropertyIncludingInherited` now delegates to
  `TypeMemberModel.TryGetProperty`, removing the duplicated base-chain
  instance-property walk. The two were verified behaviorally equivalent (same
  base-chain order, same first-match); the public signature and callers are
  unchanged in this PR.

- **Interface static coverage / known gap.** Interface static *methods* are
  covered by `LookupMember`, `GetMethods`, and now `EnumerateMembers`.
  `InterfaceSymbol` does not currently model static *properties* or static
  *events* (no `StaticProperties`/`StaticEvents` tables), so
  `TryGetStaticProperty`/`TryGetStaticEvent` expose only what the symbol model
  supports. Surfacing interface static properties/events would require deeper
  `InterfaceSymbol` modeling and is deferred as future work for the A9
  migration.

- **Reserved `MemberKinds.NestedType`.** Added as a reserved flag value (not
  included in `All`) for future nested-type routing. Nested-type enumeration is
  not wired in P0; it remains future work to avoid scope creep.

## Addendum — A8: operator and protocol single-method lookups

The A8 consumer-migration PR routes the binder's single-method-by-name probes
through the canonical layer. No behavior, ordering, or diagnostics changed; the
new helper is a line-for-line mirror of the instance method it replaces.

- **Canonical single-method helper.** Added
  `TypeMemberModel.TryGetMethodIncludingInherited(TypeSymbol, string, out
  FunctionSymbol)`. It mirrors `StructSymbol.TryGetMethodIncludingInherited`
  exactly: the FIRST instance method by name, in declaration order within each
  level, walking the base chain this-first — instance methods only, no overload
  set, no statics. The helper is `StructSymbol`-only by design (all current
  callers pass a user struct); the original instance method is unchanged.

- **Consumer migrations.** User-operator resolution (unary and binary, left and
  right operands) in `ExpressionBinder.Operators.cs`, duck-typed iterator
  probing (`GetEnumerator`/`MoveNext`) in `MemberLookup.cs`, and `using`/`defer`
  dispose probing (`Dispose`/`DisposeAsync`) in `ConversionClassifier.cs` now
  call the canonical helper instead of the `StructSymbol` instance method. The
  surrounding parameter/return-type, accessibility, and bound-node construction
  logic is unchanged. CLR-reflection operator/dispose fallbacks are untouched.

## Addendum — A9: interface member enumeration (final consumer migration)

The A9 consumer-migration PR is the final step of ADR-0112. It routes the
binder's remaining by-name interface *method* overload-set probes — including the
interface-method sites deferred from A6 — through the canonical layer, so that no
genuine by-name user-type member resolution remains outside `TypeMemberModel`. No
behavior, ordering, IL, or diagnostics changed for any working program.

- **Parity enabler — `EnsureMembersResolved` visibility.**
  `InterfaceSymbol.EnsureMembersResolved()` changed from `private` to `internal`
  so the canonical layer (same assembly/namespace) can guarantee the lazy member
  tables of a *constructed* generic interface instance are substituted/populated
  before enumeration. `TypeMemberModel.GetMethods`'s interface branch now calls
  `interfaceSymbol.EnsureMembersResolved()` at the start of the branch, exactly as
  the original `InterfaceSymbol.GetMethods(name)` did. This is idempotent, adds no
  `BinderContext` dependency, and only populates the method tables.
  - In practice the explicit guard is defense-in-depth: the `Methods` /
    `StaticMethods` property *getters* already invoke `EnsureMembersResolved`, and
    those getters are what the interface branch reads. The explicit call makes the
    contract uniform and robust against future refactoring that might read a
    backing field directly. The other interface branches in `TypeMemberModel`
    (`EnumerateInterfaceMembers`, `LookupInterfaceMember`) reach methods via those
    same resolving getters / `TryGetMethod` / `TryGetStaticMethod` accessors (which
    also resolve), and reach `Properties` / `Events` via eagerly-populated tables
    (`SetProperties`/`SetEvents`; `TryResolveMembers` substitutes *methods* only).
    No additional guards were therefore required on the property/event branches —
    `EnsureMembersResolved` would have no effect there.

- **Dedup parity (verified).** `InterfaceSymbol.GetMethods` does not dedup;
  `TypeMemberModel.GetMethods` applies `AddMethodsDeduped`
  (`BoundScope.FunctionSignaturesEqual`). The declaration binder
  (`DeclarationBinder.cs`, interface member pass) already rejects two same-name
  methods with identical signatures on one interface via the *same*
  `FunctionSignaturesEqual`, for both instance and static buckets. Dedup is
  therefore a no-op for interfaces and order/content are preserved.

- **Consumer migrations (interface method overload sets).** Four sites replaced
  `<ifaceExpr>.GetMethods(name)` with
  `TypeMemberModel.GetMethods(<ifaceExpr>, name, MemberQuery.Instance(MemberKinds.Method))`,
  leaving all surrounding logic (private-helper bucket via `GetPrivateMethods`,
  `IsInsideSameInterface`, `AddRange`, visibility diagnostics, overload selection,
  and the default-interface-method `HasDefaultBody` filter) unchanged:
  - `ExpressionBinder.Calls.cs` — interface-typed receiver dispatch.
  - `ExpressionBinder.Calls.cs` — type-parameter sealed-interface-constraint dispatch.
  - `ExpressionBinder.Calls.cs` — default-interface-method probe (then filtered by `HasDefaultBody`).
  - `OverloadResolver.cs` — implicit-self (`this`) interface method dispatch.

- **Consumer migration (constrained static-virtual enumeration).**
  `ExpressionBinder.Access.cs` (`BindTypeParameterStaticAccessorStep`, call arm)
  replaced its hand-rolled `foreach (… in InterfaceConstraint.StaticMethods)` name
  scan with
  `TypeMemberModel.GetMethods(tpSym.InterfaceConstraint, methodName, MemberQuery.Static(MemberKinds.Method))`,
  keeping the param-count match + first-wins at the call site. `GetMethods` already
  filters by name (so the redundant `candidate.Name == methodName` check was
  dropped) and preserves declaration order for static interface methods, so the
  first param-count match is identical. The sibling `NameExpressionSyntax` arm only
  reports GS0333 (static-virtual properties/constants are deferred) and enumerates
  nothing, so it was left unchanged.

- **Additional site found by the residual sweep (deferred from A6).**
  `OverloadResolver.cs` implicit-static-self dispatch inside a static-virtual /
  private-static interface helper body replaced
  `implicitStaticIface.GetStaticMethods(name)` with
  `TypeMemberModel.GetMethods(implicitStaticIface, name, MemberQuery.Static(MemberKinds.Method))`
  — a clean exact-parity static interface-method by-name lookup mirroring the
  instance path migrated in A6. The adjacent `GetStaticPrivateMethods` private
  bucket is left as-is.

- **Explicit exclusions (documented, not migrated).**
  - `LanguageServer/CrossAssemblyDefinitionResolver.cs` — Category C
    Go-to-Definition declaration mapping: reverse-maps a CLR `MemberInfo` to a
    source-declared symbol, gated on `Declaration != null` with bespoke arity
    matching (`SelectMatchingMethod`). Not by-name resolution.
  - `ExpressionBinder.Calls.cs` DIM open-method **index** matching
    (`var overloads = ifaceSym.Methods;` and `ifaceSym.Definition.Methods[idx]`) —
    behavior-sensitive structural code, not a name lookup.
  - `InterfaceSymbol.GetPrivateMethods` / `GetStaticPrivateMethods` and the
    private-helper bucket — a separate concern not modeled by `TypeMemberModel`.
  - Category C declaration-time table building / interface-impl validation
    (`Binder.cs`, `DeclarationBinder.cs`, `IncrementalGlobalScopeReuse.cs`) and all
    CLR-reflection / imported-type paths (`ClrOperatorResolution.cs`,
    `ConversionClassifier.cs`, `MemberLookup.cs` CLR-contract matching).
  - Public accessors (`InterfaceSymbol.GetMethods`, `GetStaticMethods`,
    `StructSymbol.GetMethodsIncludingInherited`, etc.) are retained in place.

- **Residual sweep classification (`src/Core/CodeAnalysis/Binding/`).** Every
  remaining direct member-table access was classified as (a) declaration-time
  table building / validation, (b) CLR reflection / imported types, or
  (c) behavior-sensitive structural (DIM index match; private-method bucket;
  single-level `StructSymbol.TryGetField` used for delegate-field invocation that
  needs the declaring type, duck-typed enumerator `Current`, positional/param-name
  field matching, and declaration-time duplicate-name detection). No category (d)
  genuine by-name user-type member resolution remains outside `TypeMemberModel`
  beyond the sites migrated above. The single-level `StructSymbol.TryGetField`
  sites are *not* exact-parity with the base-walking `TypeMemberModel.TryGetField`
  and were intentionally left to preserve their narrower (single-level / declaring-
  type) semantics.

- **Test coverage.** The existing interface, default-interface-method, private
  interface-helper, generic sealed-interface-constraint, and static-virtual suites
  (Core.Tests + Compiler.Tests `Interface|DefaultInterface|Constraint|StaticVirtual|Generic`
  filters) exercise the migrated paths, including constructed (lazily-resolved)
  generic interface instances, and remain green. A "fails-without-the-enabler"
  source-level repro is **not constructible**, because the public `Methods` /
  `StaticMethods` getters already trigger `EnsureMembersResolved` on first access;
  the explicit guard is robustness/intent documentation rather than a behavior fix,
  so the existing generic-constraint suites are relied upon.

### Final state of ADR-0112

With A9 the unified member-resolution migration is **complete**: all genuine
by-name user-type member resolution in the binder — struct and interface, instance
and static, field/property/event/method, single-member and overload-set — flows
through `TypeMemberModel`. The remaining direct symbol-table accesses are
declaration-time table building, CLR reflection, or behavior-sensitive structural
code that the model deliberately does not abstract. The only known modeling gap is
the P0-noted absence of interface static *properties* / static *events* on
`InterfaceSymbol` (no `StaticProperties`/`StaticEvents` tables); surfacing those
remains future work requiring deeper symbol modeling, independent of this
migration.
