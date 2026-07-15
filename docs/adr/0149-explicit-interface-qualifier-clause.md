# ADR-0149: Explicit-interface qualifier clause

- **Status**: Accepted
- **Date**: 2026-07-15
- **Phase**: Compiler / cs2gs interop hardening
- **Related**: #2010, #2181, #2362, #2371 (superseded convention)

## Context

Issues #2010 (methods) and #2362 (properties) needed a way to represent C#'s explicit interface implementation (`void IFoo.M() { ... }`, `int IFoo.P { get; }`) in G#, since two implemented interfaces can each declare a same-named member and C# lets a class implement both separately.

The first shipped solution (PR #2370's original form) represented this with a **reserved mangled name** on an ordinary private member: `private func __explicit_IFoo__M() ...`. This worked but had real costs:

- The mangled name was a source-visible, hand-parsed string convention (`__explicit_<Interface>__<Member>`), duplicated in both `gsc`'s binder (to parse the name back into interface + member) and `cs2gs`'s translator (to generate it). Any qualifying interface with dots, generics, or unusual characters needed ad hoc escaping.
- Diagnostics, hovers, and reflection all showed the mangled name instead of the real member name, which is confusing and leaks an implementation detail into the public surface.
- Multiple explicit implementations of generic interface instantiations (e.g. `IComparer[int]` vs `IComparer[string]`) could not be disambiguated cleanly by name alone.
- Indexers and events had no representation at all.

## Decision

Add a dedicated **explicit-interface qualifier clause** `(InterfaceType)` immediately after the member keyword, syntactically parallel to the pre-existing Go-style receiver clause:

```
func (IFoo) M(...) T { ... }
prop (IFoo) P T { get; set; }
prop (IFoo) this[i int32] T { get; set; }
event (IFoo) Changed T
```

The qualifier accepts any type reference grammar: a simple name (`IFoo`), a qualified name (`NsA.IFoo`), or a generic instantiation (`IComparer[int32]`). Source symbol names, diagnostics, hovers, and reflection all show the **plain member name** (`M`, `P`) — disambiguation between multiple same-name explicit implementations is entirely carried by the clause's interface type, never by mangling the name.

### Grammar and disambiguation

`ParseOptionalExplicitInterfaceClause` is a single reusable parse helper shared by `func`, `prop`, and `event` declarations. For `prop`/`event` there is no competing grammar, so any `(` immediately after the keyword unambiguously starts the clause. For `func`, the clause must be distinguished from the pre-existing receiver clause (`func (recv RecvType) Name(...)`, ADR-0019/ADR-0084) — both start with `(` `IdentifierToken`.

The initial disambiguation heuristic (peek one token past the identifier: `.`, `[`, or `)` all meant "this is a single type reference") had a genuine ambiguity: `Identifier [` is the same token shape whether `[` starts a generic-argument list on that identifier (`IFoo[T]`, a qualifier clause) or starts a **second**, separate array-shaped type for a receiver (`(self []T)`, `(self [3]T)`). `LooksLikeExplicitInterfaceClause` now resolves this by speculatively scanning a full type clause with the existing `TryScanTypeClause` lookahead scanner (already used elsewhere to disambiguate generic call sites) starting right after the `(`, and only commits to the qualifier-clause interpretation when that scan consumes tokens up to and including the closing `)` with nothing left over. A receiver's array-shaped type fails this scan (`self` alone has no valid generic-argument list) and correctly falls through to the receiver-clause heuristic instead.

### Binder

`ResolveExplicitInterfaceClauses` resolves the qualifier's type reference directly (not by string-parsing a name), verifies it names an interface the containing type implements, matches it against an exact member signature/accessor shape on that interface, and sets the member's `ExplicitInterfaceMember`/slot directly. Explicit members are keyed by `(interface identity, member kind, name, signature)` rather than by a unique display name, so multiple same-name qualifier-clause members coexist without tripping the ordinary duplicate-overload/duplicate-member diagnostics — those checks are exempted whenever either candidate carries an explicit-interface clause.

### Emit

Emission reuses the existing `MethodImpl`-based override bridge from #2010/#2181 unchanged: a collision-free internal CLR/emitted name is still synthesized as an implementation detail, but it is never source-visible. Property, event, and indexer accessors reuse the same metadata-naming synthesis path. Any accessor carrying an explicit-interface clause is emitted as CLR `private`, `virtual`, `newslot`, `final` — matching real C# explicit-interface-implementation semantics — instead of the previously hardcoded `public`; ordinary (non-explicit) accessors are unaffected.

### cs2gs translator

`TranslateMethod`/`TranslateProperty`/`TranslateIndexer`/`TranslateExplicitEvent` all compute the qualifier's `GTypeReference` with the same `typeMapper.Map(...)` helper already used for base-interface-list translation, and always emit the plain member name plus the clause for a G# USER interface — never a mangled name. An EXTERNAL/BCL interface (no G# `interface` declaration exists to name in a clause) still uses the pre-existing #1911-style forced-public, collision-drop-with-diagnostic fallback for every member kind. A field-like C# event declaration (`event Handler Name;`) can never carry an explicit interface specifier in C# itself, so `TranslateEventField` is unaffected — only the custom add/remove accessor form needed the clause-based rewrite.

## Consequences

- The mangled-name convention (`__explicit_<Interface>__<Member>`, `MangleExplicitInterfaceImplName`/`QualifyInterfaceName`) is deleted; there is no supported migration path for hand-authored G# source that used it, since it was never documented as public surface and existing tests using it were rewritten.
- G# interfaces can now declare indexer members (`prop this[...] T { get; set }`) — the previous unconditional rejection (`GS0371`) is removed. Interface indexers share the pre-existing "one plain indexer per type" limitation that struct/class indexers already had; multiple *explicit* indexer implementations across different interfaces still coexist fine (each interface has its own independent member list).
- ADR-0148 was independently claimed by the concurrently-merged "safe structural projections" feature (#2372); this document is numbered 0149 to avoid the collision. Any historical code comments referencing "ADR-0148" for the explicit-interface qualifier clause predate this renumbering and should be read as ADR-0149.
- Two narrower, pre-existing gaps are now fully closed by follow-up work on this same ADR (see "final completion pass", issue #2370):
  - **Static explicit-interface members** — `func (IFoo) M(...)` / `prop (IFoo) P T` inside a `shared { }` block, implementing a C# 11 `static abstract`/`static virtual` interface member (ADR-0089/#755/#1019) — are fully supported. `DeclarationBinder.TryResolveExplicitInterfaceStaticImplementation`/`TryResolveExplicitInterfaceStaticPropertyImplementation` mirror the instance-member resolvers exactly, short-circuiting `VerifyStaticVirtualInterfaceImplementations`/`VerifyStaticVirtualInterfacePropertyImplementations`'s pre-existing name-based match; `ResolveExplicitInterfaceClauses`/`VerifyExplicitInterfaceClauseResolution` walk `StaticMethods`/`StaticProperties` alongside the instance collections (with a separate slot-identity dictionary, since a static-virtual slot and an instance slot of the same interface/name are never the same CLR vtable slot); the duplicate-name exemption in the `shared` block's binder loop (mirroring the instance-member exemption) lets two same-named static-virtual members from two *different* interfaces coexist — previously impossible even by name (an exact-signature `GS0264` duplicate) under the pre-#2370 name-only static-virtual scheme. `ReflectionMetadataEmitter.EmitStaticVirtualMethodImpls`/`EmitStaticVirtualPropertyMethodImpls` prefer a clause-resolved `ExplicitInterfaceMember` link over the name-based scan when emitting `MethodImpl` rows. The cs2gs translator required **no changes at all**: `TranslateMethod`/`TranslatePropertyOrIndexer` already key off Roslyn's `ExplicitInterfaceImplementations` without special-casing `IsStatic`, and static-vs-instance routing into a G# `shared { }` block is an orthogonal, later step. There is no static indexer or static event form in C#/the CLR at all (indexers always require an instance receiver; interfaces cannot declare `static abstract`/`static virtual` events — G#'s parser already rejects both: a `shared` indexer is rejected by `ReportIndexerRequiresAccessorBody`, and an `event` inside an interface `shared` block is rejected by `GS0330`), so only methods and properties needed this generalization.
  - **Interface-typed receiver call-site access** for indexers (`asIface[i]`) and events (`asIface.Changed += h`) now binds. `ExpressionBinder.Access.cs` gained an `InterfaceSymbol` overload of `TryGetUserIndexer` (READ/WRITE), `BoundEventSubscriptionExpression.StructType` was widened from `StructSymbol` to `TypeSymbol`, and `ExpressionBinder.Async.cs` gained an `InterfaceSymbol` branch for event `+=`/`-=`; `MethodBodyEmitter.Closures.cs`'s `EmitUserEventSubscription` resolves the correct token for a (possibly generic) interface owner and forces `callvirt`. This is generalized across source, imported/BCL (e.g. `List[int32]`/`IList[int32]`), and generic interfaces, and covers both ordinary and explicit interface indexer/event members. Fixing this call-site gap also surfaced (and required fixing) four pre-existing latent bugs where `InterfaceSymbol.Events`/`.Properties` were read directly instead of via `iface.Definition ?? iface` — `Events`/`Properties` are never substituted onto a *constructed* generic interface instance (only `Methods`/`StaticMethods` are, per `InterfaceSymbol.TryResolveMembers`) — affecting `TypeMemberModel.TryGetEvent`, `MemberDefEmitter.PropertyImplicitlyImplementsInterface`/`EventImplicitlyImplementsInterface` (which decide whether an ordinary/implicit member is promoted to a CLR interface vtable slot), and `VerifyStaticVirtualInterfacePropertyImplementations` (which silently never verified a static-virtual property requirement declared on a *generic* interface before this fix). Note: an ordinary (non-explicit) indexer still can never satisfy an interface indexer contract by plain name (a pre-existing, intentional ADR-0118 design constraint, not part of this gap) — only the explicit `(IFoo)` clause can implement an interface's indexer requirement.

## Alternatives considered

- **Keep the mangled-name convention but qualify with better escaping**: rejected — it doesn't fix the diagnostic/reflection visibility problem, and every consumer (binder, translator, IDE tooling) still has to parse a string convention instead of reading a real syntax node.
- **Represent the qualifier as `FunctionDeclarationSyntax.Receiver`**: rejected — a receiver clause `(name Type)` is semantically an *extension receiver parameter*, not an explicit-interface qualifier; reusing it would conflate two unrelated concepts and the two are simultaneously representable in principle (an extension method is never also an explicit interface implementation on today's grammar, but overloading the same AST node would make that invariant implicit rather than structural).
