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

Emission reuses the existing `MethodImpl`-based override bridge from #2010/#2181 unchanged: a collision-free internal CLR/emitted name is still synthesized as an implementation detail, but it is never source-visible. Property accessors reuse the same metadata-naming synthesis path as ordinary properties.

### cs2gs translator

`TranslateMethod`/`TranslateProperty` compute the qualifier's `GTypeReference` with the same `typeMapper.Map(...)` helper already used for base-interface-list translation, and always emit the plain member name plus the clause — never a mangled name. `TranslateIndexer` intentionally does **not** wire the clause through: G# interfaces cannot declare indexer members at all (a separate, pre-existing limitation, `GS0371`), so doing so would convert today's semantic-loss collision-drop fallback into a guaranteed compile failure; indexers keep the old fallback behavior unchanged.

## Consequences

- The mangled-name convention (`__explicit_<Interface>__<Member>`, `MangleExplicitInterfaceImplName`/`QualifyInterfaceName`) is deleted; there is no supported migration path for hand-authored G# source that used it, since it was never documented as public surface and existing tests using it were rewritten.
- Indexer and event explicit implementations are scoped narrower than methods/properties: events have parser/AST/symbol plumbing only (no binder/emit support yet); indexers are excluded entirely per the interface-indexer limitation above. Both are deferred follow-up work.
- ADR-0148 was independently claimed by the concurrently-merged "safe structural projections" feature (#2372); this document is numbered 0149 to avoid the collision. Any historical code comments referencing "ADR-0148" for the explicit-interface qualifier clause predate this renumbering and should be read as ADR-0149.

## Alternatives considered

- **Keep the mangled-name convention but qualify with better escaping**: rejected — it doesn't fix the diagnostic/reflection visibility problem, and every consumer (binder, translator, IDE tooling) still has to parse a string convention instead of reading a real syntax node.
- **Represent the qualifier as `FunctionDeclarationSyntax.Receiver`**: rejected — a receiver clause `(name Type)` is semantically an *extension receiver parameter*, not an explicit-interface qualifier; reusing it would conflate two unrelated concepts and the two are simultaneously representable in principle (an extension method is never also an explicit interface implementation on today's grammar, but overloading the same AST node would make that invariant implicit rather than structural).
