# ADR-0018: Interface default methods — not in Phase 3

- **Status**: Partially superseded by ADR-0078 (declaration-head spelling) — the default-interface-methods deferral described below is unchanged.
- **Date**: 2026-05-22
- **Phase**: Phase 3 (lock before 3.B.4); revisit in Phase 6
- **Superseded**: The declaration-head examples below use the legacy `type Name interface` form. ADR-0078 replaces them with `interface Name` and `sealed interface Name` (the sealed variant is new).
- **Related**: ADR-0003 (OO surface); ADR-0017 (method virtuality); ADR-0078 (Kotlin/Swift declaration head); execution plan §3.B.4

## Context

Phase 3.B.4 introduces user `interface` declarations. The decision is whether an interface body may carry **method implementations** (Default Interface Methods — DIM, in C# 8+), or whether it is strictly a contract of signatures.

Three precedents:

| Language | Behavior |
| --- | --- |
| C# (since 8) | DIM allowed; diamond resolution rules are intricate. |
| Java (since 8) | `default` methods allowed; similar diamond rules. |
| Go | No DIM — interfaces are pure method-set contracts. |
| Kotlin | DIM allowed but discouraged; Kotlin docs recommend abstract classes instead. |

Trade-offs:

- DIM is a way to *extend* an interface in a binary-compatible manner: add a new method with a default, existing implementors stay valid.
- DIM brings two costs: (1) diamond resolution rules become user-visible, (2) the "behavior lives on the contract" pattern erodes the data-vs-behavior separation that ADR-0003 prizes.
- The Phase 3 milestone is "user-defined interface consumed via dynamic dispatch." DIM isn't required to hit that bar.
- Extension functions (Phase 3.B.6, ADR-0019) cover the *additive* use case ("give every implementor of `IFoo` a `helper()`") without putting code on the interface itself. They cannot, however, give an interface method a *fallback* implementation that a subtype can call via `base.Method()` — that's the irreducible DIM use case.

## Decision

**GSharp interfaces in Phase 3 contain method signatures only — no bodies, no `default` keyword, no static members.**

- Parser rejects any body or `=>` on a method declared inside an `interface { … }`. Diagnostic: `Interface method 'I.Method' may not have a body in this version of GSharp; see ADR-0018.`
- Static methods on interfaces, static abstract members (C# 11), and operator slots are likewise rejected in Phase 3.
- **Phase 6** (or later) may revisit DIM. The reopening criterion is a concrete, citeable user request that extension functions and abstract classes cannot satisfy. The revisit ADR must spell out a diamond-resolution rule (recommend C#'s "most-specific override wins; explicit qualification otherwise") before reopening.

CLR emission: an interface is emitted as `TypeAttributes.Interface | Public | Abstract` with abstract instance methods (`virtual abstract` slots). No additional members. No marker attribute.

## Consequences

Positive:

- Phase 3.B.4 ships in days, not weeks. The DIM design space is large and tangential to the gaps doc's headline goals.
- The data-vs-behavior split stays clean: interfaces are pure contracts; behavior lives in implementing types or in extension functions.
- Avoids surfacing the diamond-resolution rule to users this early in the language's life. The rule is hard to teach and rarely understood correctly even by experienced C# developers.
- Cross-language interop unaffected: a GSharp interface is just a CLR interface; C# can implement it, F# can implement it.

Negative:

- Library authors cannot add a new interface method without breaking every implementor. Mitigation: encourage `sealed interface` (ADR-0003) for ADT-style closed sets, where the author owns every implementor.
- Users porting code from Kotlin/Java/C# that depends on DIM must rewrite as an abstract class or as extension functions.

Neutral:

- Re-evaluating in Phase 6 means a Phase 3 user could write extension functions, and a Phase 6 user could later rewrite some of them as DIM. The migration path is monotonic — extension functions don't become wrong when DIM lands.

## Alternatives considered

- **Ship DIM in Phase 3**: rejected. The diamond-resolution rules, `base.Method()` semantics, abstract-vs-concrete partial-implementation analysis, and the CLR `MethodImpl` table dance together cost weeks. Phase 3's headline value (structs, classes, exceptions, nullability) is higher.
- **Ship interfaces without `default` but allow `static` methods on them**: rejected. Inconsistent surface; the rationale for excluding bodies applies symmetrically to static-with-body.
- **Permanently exclude DIM**: rejected. The binary-compat use case is real; foreclosing it now would constrain the v1.0 spec. "Not in Phase 3; revisit Phase 6+" is the right strength of commitment.
