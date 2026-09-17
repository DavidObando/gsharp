# ADR-0183: Narrow immutable (`let`) fields and get-only auto-properties across statement boundaries

- **Status**: Proposed
- **Date**: 2026-09-17
- **Phase**: Phase 9 — language depth / flow analysis
- **Amends**: ADR-0069 (Kotlin-style smart cast flow narrowing) — specifically
  the *Where narrowing applies* section and the "Narrow through fields and
  properties" entry under *Considered alternatives*, and the #1180 addendum's
  restriction of member-path narrowing to a single guarded branch.
- **Related**: ADR-0001 (null model), ADR-0067 (fields require `var`/`let`),
  ADR-0068 (`deinit` destructor support), ADR-0100 (`default(T)` and struct
  zero-initialization), ADR-0155 (incremental nullable adoption); issue
  #4262 (cs2gs nullability investigation) and its items 1 (#4277), 2
  (#4280), and 3 (same-session audit of the `viewModel` cross-method case);
  `SmartCastStability` (`src/Core/CodeAnalysis/Binding/SmartCastStability.cs`);
  `IsStableMemberSymbol` (`tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.Expressions.cs`)

## Context

ADR-0069 gave gsc Kotlin-style smart-cast narrowing for locals and
parameters, and its #1180 addendum extended narrowing to **stable
member-access paths** (`b.Pet`, `o.Box.Pet`) — but only *within the single
guarded branch or block* where the test and the use appear together. The
original ADR rejected narrowing fields and properties more broadly, for a
reason that still holds in general: "a field or property read is not
idempotent (another thread or a `deinit` could change it), so narrowing
across two reads is unsound." Kotlin makes the identical call for `var`
properties, for the identical reason.

That blanket caution was never differentiated by field mutability, and this
session's cs2gs work shows the cost of not differentiating it. Issue #4262's
investigation instrumented a real migrated corpus (Oahu) and found that,
across 787 in-method `!!` sites, **220 (28%) have a null-guard on the same
field or property earlier in the same method** — gsc cannot narrow the
member across the statement boundary, so cs2gs (the C#→G# migration tool)
was forced to re-assert `!!` at every dereference Roslyn had already proven
safe. Item 2 of that investigation (PR #4280) shipped a cs2gs-side
workaround: when a guard and its uses share one method, and the guarded
member is a genuinely immutable field or get-only auto-property (reusing the
`IsStableMemberSymbol` predicate from item 1, PR #4277), cs2gs captures the
member into a local right after the guard and rewrites the later reads to
use that local, collapsing N redundant `!!` sites into one assertion gsc's
own local-narrowing then carries for free.

That workaround has a hard ceiling: it only helps when the guard and every
downstream use are lexically inside the *same method*. Item 3 of this
session's investigation audited the worst real offender in the corpus — a
field named `viewModel`, responsible for 84 forced `!!` sites — and found it
is **not reachable by the same-method capture at all**: the null-guard and
the dereferences live in different methods on the same object (a common
shape — a guard in a lifecycle/setup method, uses scattered across handler
methods that all assume the guard already ran). No cs2gs-side rewrite can
fix this, because cs2gs only ever restructures the body of one method at a
time; the fact that "this field is non-null for the rest of the object's
usable lifetime, once this guard has run" is a property of the *type*, not
of any one method, and only gsc itself is positioned to reason about it.

This ADR proposes the language-level narrowing that would close that gap —
scoped, deliberately, to the one case where ADR-0069's stated concern
provably does not apply.

## Why ADR-0069's concern does not block every field

ADR-0069's objection is about **mutability**, not about "fields versus
locals" as such — re-read the sentence: the risk is that another thread or a
computed getter changes the *value* between the check and the use. That risk
has two independent sources:

1. **The storage can be reassigned.** A `var` field, or a settable/virtual
   property, can have its value replaced after the guard ran, by another
   thread, by a reentrant call, or by an override further down the call
   chain. Narrowing across such a reassignment is unsound, full stop — this
   is exactly Kotlin's rule for `var` properties, and G# should keep
   declining it, exactly as ADR-0069 already decided.
2. **The read is not idempotent.** A custom/computed getter can return a
   different value on every call even with no reassignment involved (a
   `DateTime.Now`-style property, a lazily-recomputed derived value). Two
   reads of such a member are not the same fact, so narrowing across them is
   unsound independent of thread-safety.

A **`let`-declared instance field** (emitted `initonly`) and a **genuinely
get-only, non-virtual, non-overridable auto-property (no setter at all)**
are immune to *both* sources by construction, not by convention:

- Source 1 does not apply: `let` fields cannot be reassigned after the
  constructor that initializes them runs — the CLR enforces this at the IL
  level (`initonly`), and ADR-0067 already makes this the only spelling for
  an immutable field. A get-only auto-property with **no setter at all**
  has the identical guarantee, transitively, because it is backed by
  exactly such a field: `DeclarationBinder.Structs.cs`'s auto-property
  backing-field construction emits `isReadOnly: !hasSetter`, so when there
  is no setter the backing field is `initonly` and the CLR itself rejects a
  write outside the declaring constructor, exactly like a spelled-out `let`
  field.
- Source 2 does not apply: an auto-property has no custom getter body — the
  read is a plain field load, which is trivially idempotent.

**An `init`-only auto-property (`{ get; init; }`) does *not* have this same
guarantee, and stating otherwise would be a real soundness gap in this
ADR.** `hasSetter` is `true` for an `init` accessor — it is an ordinary
setter method at the CLR level, distinguished from a normal setter only by
an `IsExternalInit` `modreq` (`MemberDefEmitter.cs`) that a *conformant
compiler* checks at the call site, not something the CLR itself enforces on
the write. Consequently the same `isReadOnly: !hasSetter` line gives an
`init`-only property's backing field `isReadOnly: false` — an ordinary,
CLR-mutable field. Nothing in IL verification stops a second, later call to
the `init` accessor method: a non-conformant or hand-rolled IL emitter, a
different managed language, or a codegen tool that does not honor
`modreq(IsExternalInit)` can call `set_Foo(value)` after construction with
no CLR-level objection — unlike a genuinely `initonly` field, which even
*verifiable* IL cannot write outside the declaring constructor. This is a
narrower, more mundane threat than the reflection-based `FieldInfo.SetValue`
bypass this document already treats as out of scope for `readonly` fields
(that one requires deliberately calling into the reflection API against the
field's own protection); calling an ordinary public method needs no special
API at all.

`SmartCastStability.IsStableProperty` already accepts `init`-only equally
with get-only, and #1180 already trusts that predicate — this ADR does not
revisit that existing, narrowly-scoped (single-branch) trust. #1180's trust
window is short enough that it never needs to reason about an intervening
call at all: test and use sit inside one guarded block, and #1180 already
invalidates the narrowing on *any* intervening call regardless of member
kind, so the get-only/`init`-only distinction is simply never exercised
there. This ADR's contribution is exactly the place that distinction starts
to matter: widening the window means the narrowing must now survive across
statements that *do* contain calls, and once a call is in scope, two
different questions arise that this document must not conflate —

1. Can a **caller gsc itself compiled** invoke the `init` accessor again
   during that window? No — G#'s own binder only accepts an `init` accessor
   call inside the declaring object's initializer syntax, so no G#-compiled
   code anywhere can be the culprit.
2. Can the **callee being invoked** — an imported method from another
   assembly, or anything *that* method transitively calls — invoke the
   `init` accessor's ordinary `set_Foo` method via its own, non-conformant
   IL, bypassing the `modreq(IsExternalInit)` check a conformant compiler
   would have enforced at *its* call site? Yes, in principle, and gsc has no
   way to see inside a callee it did not compile to rule this out. The
   bounded duration of Tier 1's window does not help here — only the
   *callee's provenance* would, and Tier 1's call-invalidation relaxation
   (below) does not currently condition on that.

Question 1 is what the earlier draft of this ADR answered, and it is true
but insufficient — it rules out the wrong threat. Question 2 is the actual
cross-compiler scenario this document already uses, correctly, to exclude
`init`-only members from Tier 2 (see below); the same threat applies the
moment Tier 1 lets a narrowing survive an intervening call, not only at
Tier 2's whole-object-lifetime scope. The fix carried through the rest of
this document: **Tier 1's *window-widening* (dropping the "single guarded
block only" restriction) is safe for `let` fields, get-only properties, and
`init`-only properties alike, because on its own it never needs to survive
a call. Tier 1's separate *call-invalidation relaxation* (surviving an
intervening call without losing the narrowing) is safe only for members
whose immutability the CLR itself enforces — `let` fields and genuinely
get-only properties — and does not extend to `init`-only properties, which
keep the pre-existing "any call invalidates" rule in Tier 1 exactly as they
already do outside this ADR.**

So the concern ADR-0069 raised is real, but it is a concern about `var`
fields, computed/virtual properties, and — as just established — `init`-only
properties whenever a call intervenes between the guard and the use. This
ADR proposes to keep declining `var` fields and computed/virtual properties
unconditionally (no change from ADR-0069); to widen the scope for `let`
fields and genuinely get-only properties from "single guarded branch" all
the way to Tier 2, including surviving intervening calls; and to widen the
*window* (but not the call-survival) for `init`-only properties as far as
Tier 1 — argued case by case below.

## Decision (proposed)

**Narrow a `let`-declared instance field, or a non-virtual/non-overridable
get-only-or-`init`-only auto-property — a *stable member*, exactly
`SmartCastStability.IsStableField` / `IsStableProperty` today — across
statement boundaries within the enclosing method (Tier 1), and lift the
narrowing across method boundaries (Tier 2) only through the object's
constructor-established invariants, never through a same-object guard
performed by another, unrelated method call, and only for members whose
immutability the CLR itself enforces — `let` fields and genuinely get-only
(no-setter) auto-properties, *not* `init`-only ones (see the CLR-vs-compiler
distinction above).**

Concretely, this ADR proposes two scope tiers, argued separately because
their soundness arguments are different — and because, as established
above, they trust a different set of members:

- **Tier 1's window-widening** (narrowing survives past the single guarded
  block, for the rest of the method's reachable flow) applies to every
  `SmartCastStability`-stable member: `let` fields, get-only
  auto-properties, and `init`-only auto-properties alike — this part never
  needs to reason about a call, so the get-only/`init`-only distinction
  does not apply to it.
- **Tier 1's call-invalidation relaxation** (narrowing survives an
  intervening call rather than being dropped) applies only to members whose
  immutability the CLR itself enforces: `let` fields and genuinely get-only
  auto-properties. An `init`-only auto-property's narrowing is still
  dropped by an intervening call in Tier 1, exactly as it already would be
  today — only the window widens for it, not the call tolerance.
- **Tier 2** applies only to `let` fields and genuinely get-only
  auto-properties. `init`-only auto-properties are excluded entirely — see
  the dedicated callout in the Tier 2 section below for why the
  CLR-vs-compiler distinction becomes load-bearing at that scope.

### Tier 1 — same-method, cross-statement (uncontroversial extension)

Within one method body, a nil-guard or type-test on a stable member path
(`self.viewModel != nil`, `b.Pet is Dog`) narrows that path for the
remainder of the method's *reachable, non-invalidated* flow — not just the
single guarded branch, the way the #1180 addendum currently restricts it.

This is a straightforward generalization of #1180's existing invalidation
machinery, not a new soundness argument: #1180 already computes an
`AccessPath` for a stable member chain and already invalidates it on an
intervening call, a member/indexed assignment, or a loop back-edge (see
ADR-0069 §"Invalidation (soundness)" and §"Loop back-edges"). Today's
implementation does two separate things: it throws the narrowing away the
moment control leaves the immediately-guarded block (even when nothing
invalidating happened), and — as a blanket, member-kind-agnostic rule — it
also invalidates every member-bearing path on *any* intervening call, "because
a method could mutate reachable state."

That blanket call-invalidation rule is exactly right for a `var` field, a
settable/virtual property, **and an `init`-only property**: for the first
two, a callee genuinely could reassign the storage or override the getter;
for `init`-only, a callee gsc did not compile — or anything *that* callee
transitively calls — could invoke the ordinary `set_Foo` accessor method
directly, bypassing the `modreq(IsExternalInit)` check a conformant
compiler would have enforced at its own call site, exactly the
cross-compiler threat this document already uses to exclude `init`-only
members from Tier 2. Tier 1's bounded duration does not defend against this
— only the callee's provenance would, and gsc cannot see inside a callee it
did not compile to establish that. **So the call-invalidation relaxation
below applies only to `let` fields and genuinely get-only (no-setter)
auto-properties — the members whose backing storage is CLR-`initonly` — not
to `init`-only properties.**

For that CLR-enforced subset, no callee, however arbitrary or foreign, can
reassign `initonly` storage; the CLR itself rejects the write, not merely a
cooperating compiler. This ADR therefore proposes relaxing
call-invalidation specifically for stable member paths where every link is
CLR-`initonly` (`IsReadOnly` fields and no-setter auto-properties — see
`SmartCastStability.IsStableField` and the get-only half of
`IsStableProperty`) — such a path survives an intervening call unless the
call assigns to the path itself, which cannot happen for `initonly`
storage regardless of who wrote the calling code — while leaving the
existing blanket invalidation exactly as-is for any path with a mutable
link *or* an `init`-only link. Combined with dropping the "single guarded
block only" restriction for all stable paths (get-only, `init`-only, and
`let` fields alike — see *Decision* above), this is what lets Tier 1 reach
the 220 same-method sites item 2 measured for the CLR-enforced subset
outright, and reach the `init`-only subset wherever the guard and the use
have no intervening call between them (still an improvement over today's
single-block restriction, just not the full call-surviving benefit).

```gs
class Session {
    let viewModel ViewModel?
    prop config Config? { get; init; }   // init-only — narrower Tier 1 support

    func Setup() {
        if self.viewModel == nil { return }
        DoSomeUnrelatedWork()          // ordinary call —
                                        // `viewModel` (let field): does NOT invalidate
        self.viewModel.Refresh()       // accepted — viewModel still narrowed

        if self.config == nil { return }
        DoSomeUnrelatedWork()          // `config` (init-only): DOES invalidate —
                                        // DoSomeUnrelatedWork is a callee gsc did not
                                        // compile; it (or something it calls) could
                                        // reach config's set_Config via foreign IL
        self.config.Apply()            // rejected — narrowing was dropped by the call;
                                        // `!!` (or a same-block guard) is still required
    }
}
```

### Tier 2 — cross-method, constructor-proven non-null (the `viewModel` case)

This is the tier that actually closes the gap item 3 found, and it is where
the safety argument needs to be precise rather than convenient.

**Claim considered and rejected**: "once any method on this object has
null-checked `self.viewModel`, treat it as non-null in every other method
for the rest of the object's lifetime." This is unsound and this ADR does
not propose it. The guard in one method proves nothing about the field's
state when a *different* method runs — nothing prevents another instance
method from being entered before the guarding method ever runs (there is no
ordering guarantee between instance methods absent an explicit call graph),
and even if the guard is known to have executed, a `let` field can still be
observed as its declared type `T?` inside the type's own constructor before
the initializer that assigns it runs (partially-constructed `this`
escaping — e.g. via a virtual call from the base constructor, or a field
initializer that reads a sibling field before its own initializer runs).
Cross-method narrowing driven off *an arbitrary guard in an arbitrary other
method* cannot be proven sound with the information available at compile
time, so it is out of scope here, matching ADR-0069's original caution.

**Claim actually proposed**: a `let` field's declared type already states
what the constructor guarantees. If the field's declared type is
non-nullable (`let viewModel ViewModel`, not `ViewModel?`), every read
anywhere in the type — any method, not just the one containing a guard — is
*already* narrowed by construction: this is not new behavior, it is what
"non-nullable" already means, and no `!!` should ever appear against such a
field today. That case requires no ADR; it already works.

The actual, narrower gap Tier 2 closes is when the field's declared type
*is* nullable (`let viewModel ViewModel?`) but the constructor itself
proves it non-null before returning — e.g. the constructor assigns it
unconditionally from a non-null expression, or every code path through the
constructor assigns a non-null value. In that specific case, and only that
case, gsc may narrow the field's *declared* type itself (not a per-method
flow fact) to non-nullable for every read outside the constructor, the same
way ADR-0069's existing back-edge rules already narrow a `let` local
"initialized from a proven-non-null value" across a loop. This is
equivalent to the user having declared the field non-nullable in the first
place; the narrowing is a compiler-proved fact about the *type's shape*, not
a flow fact borrowed from one method's guard. The same argument applies
verbatim to a genuinely get-only auto-property (its backing field is a
plain `let` field under the surface syntax).

**Tier 2 does not extend to an `init`-only auto-property, even though Tier
1's window-widening does (call-survival aside — see Tier 1 above).** Tier
2's claim is not "non-null right now" but "non-null for every
read for the rest of the object's observable lifetime, including reads in
code gsc never compiled" — a public type's `init`-only property can be
written by any assembly that references it, through an ordinary,
non-reflection method call to the compiler-synthesized `set_Foo` accessor,
skipping the `modreq(IsExternalInit)` check that only a conformant G#/C#
compiler performs at the *call site*. Nothing about that call requires
reflection, an unsafe context, or malicious intent — it only requires a
compiler, hand-written IL, or a codegen tool that does not model
`IsExternalInit`, which is a meaningfully weaker bar than the
reflection-based `FieldInfo.SetValue` threat this document already excludes
elsewhere. Because Tier 2's proof is meant to outlive the compilation gsc is
currently performing, and gsc cannot see or constrain what a *different*,
not-yet-written compilation does with a public `init`-only property, this
ADR excludes `init`-only members from Tier 2 outright rather than trying to
qualify the exclusion away with a narrower condition (e.g. "only for a
sealed type in the same assembly"): even a same-assembly, non-public type
could still be handed to a reflection-emitted or dynamically-loaded
component within that same assembly without crossing an assembly boundary
at all, so an assembly-scoped carve-out would not actually close the gap it
sounds like it closes. The simple, defensible line is member-kind, not
visibility: `let` fields and get-only auto-properties are Tier-2-eligible;
`init`-only auto-properties are not, regardless of accessibility or
sealing.

**Tier 2 is scoped to `class` only — it does not apply to `struct`,
`data struct`, or `inline struct`, even though ADR-0067 permits `let`
fields on all of them.** The constructor-invariant argument depends on
every reachable instance having actually run a constructor before it is
observed, and that premise is false for CLR value types. ADR-0100 states
that `default(T)` for a user struct is field-wise zero-initialized — and
`initobj`, `default(T)`, array allocation (`new Session[5]` for a struct
`Session`), and an uninitialized struct field nested inside another struct
or array all produce a zero-valued instance **without running any
user-written constructor at all**. A `let viewModel ViewModel?` field on a
struct can therefore exist, and be legally read, sitting at its nil default
with no constructor having ever assigned it — the exact state Tier 2 claims
is unreachable. Narrowing such a field's declared type to non-nullable
would be unsound: it would suppress a null check the type system asserts is
unnecessary, over a value the constructor never touched, producing a real
`NullReferenceException` at a site `!!` used to guard and Tier 2 would now
tell the user is unnecessary. No mechanism in G# tracks or forbids
bypassed-constructor value-type instances (unlike, say, a `required`-member
enforcement that could reject uninitialized reads), so there is no
available soundness argument to extend Tier 2 to structs; `class` is the
honest boundary. Tier 1 is unaffected by this restriction — both its
window-widening and its (CLR-`initonly`-only) call-invalidation relaxation
are per-read flow facts, not a claim about every possible instance of the
type, and structs are not excluded from either.

```gs
class Session {
    let viewModel ViewModel?     // declared nullable...

    init(vm ViewModel) {
        self.viewModel = vm      // ...but every constructor path assigns non-null
    }

    func Handle() {
        self.viewModel.Refresh()  // Tier 2: accepted without a local guard —
                                    // the constructor already proved this.
    }
}
```

**What Tier 2 explicitly does NOT do**: it does not let a guard written in
`Setup()` (a non-constructor method) license a narrowing consumed in
`Handle()` (a different, unordered method). If the constructor cannot prove
non-null by itself — e.g. the field is legitimately optional and only
becomes non-null after some runtime event, which is exactly the
`viewModel`-after-lazy-initialization shape that is common in UI code — Tier
2 does not apply, and the field keeps requiring per-use `!!` or an explicit
same-method guard (Tier 1). This is the honest boundary: **this ADR closes
the sub-case where the "guard" is really a constructor invariant wearing a
guard's clothing, and declines the sub-case where the value truly becomes
non-null only partway through the object's runtime lifecycle**, because no
compile-time analysis available to gsc can prove *that* case sound. A
`viewModel` that is genuinely lazily-initialized after construction is not
fixed by this ADR; declaring it `let viewModel ViewModel?` with a real
runtime nil window is not a case Tier 2 can — or should — paper over.

(Whether the corpus's actual `viewModel` field is a Tier-2-eligible
constructor invariant or a genuinely-lazy field determined only at review
time is a fact about that codebase, not something this ADR can settle in
the abstract — see *Impact* below for how this bounds the claim honestly.)

### `this`-escape edge case (class instances only — see the `struct` scoping above)

A `let` field's constructor-invariant proof (Tier 2) is unsound if `this`
can escape the constructor — passed to another object, registered as an
event handler, spawned onto another thread — *before* the assigning
statement runs, because the escaped reference could be read from that other
context while the field is still in its default (nil) state. gsc must
verify, as part of proving the Tier 2 invariant, that no expression
evaluated before the assignment can observe `this` escaping: no call passing
`this` (or an implicit-`this` closure) as an argument, no assignment of
`this` to any field/global/static, and no virtual call on `this` (which
could dispatch to overriding code in a not-yet-fully-constructed subclass
that reads the field early) precedes the assignment in every constructor
path. This mirrors definite-assignment analysis gsc already performs for
`let` fields (ADR-0067); Tier 2 piggybacks on that existing pass rather than
inventing a new one — if definite assignment cannot already prove the field
assigned on every path before `this` could escape, Tier 2 does not fire, and
the field keeps its declared nullable type outside the constructor.

**A fourth escape vector: `deinit` (ADR-0068).** This ADR's own Context
section quotes ADR-0069's original rationale verbatim — "another thread or a
`deinit` could change it" — so `deinit` needs its own answer here, not
silent omission. `deinit` lowers to an override of `Finalize`, and the CLR
runs finalizers on partially-constructed objects: if a class's constructor
allocates the instance and then throws *before* the field-assigning
statement runs — including a throw in a base-class constructor that runs
before a derived class's own field initializers — the GC can still invoke
`Finalize` on that object once it becomes unreachable, and the `deinit` body
can read the field in its pre-assignment nil state. None of the three
mechanisms above (argument-passing, field/global assignment, virtual
dispatch) catches this, because no user code caused the escape — the CLR's
finalization contract itself is the escape vector. Tier 2 must therefore
additionally require that the declaring class (and every base class between
it and `System.Object`) **declares no `deinit`** before treating a
constructor-provable field as narrowable; a class with a `deinit` anywhere
in its base chain keeps the field at its declared nullable type outside the
constructor, regardless of how simple the constructor's assignment is. This
is a conservative, purely syntactic check (does any type on the chain
declare `deinit`), not a flow analysis, so it costs Tier 2 nothing beyond a
base-chain walk gsc already performs for other purposes.

## Impact, sized against this session's measurements

- PR #4280 (item 2) reports 220 of 787 in-method `!!` sites (28%) have a
  same-method guard on the underlying field/property. For the CLR-enforced
  subset (`let` fields and genuinely get-only properties), Tier 1's
  call-invalidation relaxation lets gsc accept these programs directly
  regardless of intervening calls — no `!!` needed at any of those sites —
  which lets #4280's local-capture rewrite be **simplified or retired
  outright** for that subset: cs2gs would simply stop inserting `!!` there
  in the first place, the same way it already stops for a plain narrowed
  local. For `init`-only properties, Tier 1's window-widening still helps
  wherever the guard and the use have no intervening call between them, but
  any guard/use pair separated by a call still needs #4280's capture
  rewrite (or a per-use `!!`) exactly as before — Tier 1 does not close
  that portion of the 220 for `init`-only members. #4280's mutable-member
  fallback path (settable/virtual members, name collisions, loop-carried
  writes, closures, `goto`) is unaffected either way — Tier 1 only ever
  helps the already-`IsStableMemberSymbol`-eligible subset, which is
  exactly the subset #4280 restricts its own capture rewrite to.
- Item 3's `viewModel` example (84 forced `!!` sites, cross-method) is the
  case no cs2gs-level fix could reach. Whether Tier 2 closes it depends on
  four separate facts about that codebase, none of which this ADR can
  settle in the abstract: whether `viewModel` is a `let` field or a
  genuinely get-only auto-property rather than an `init`-only one (Tier 2
  excludes `init`-only members outright — see the CLR-vs-compiler
  distinction above), whether the declaring type is a `class` (Tier 2 does
  not apply to a `struct`/`data struct`/`inline struct` at all — see the
  scoping above), whether that type or any base class declares `deinit`
  (which would also disqualify it), and whether the constructor actually
  proves the field non-null on every path (the original caveat). If all
  four hold, Tier 2 closes the entire cluster; if the member is genuinely
  lazily-initialized post-construction, is `init`-only, is declared on a
  struct, or sits on a `deinit`-bearing type, none of the tiers proposed
  here help it, and that
  would be worth stating plainly in the PR that evaluates this ADR against
  the real corpus, rather than assumed going in.
- Neither tier touches `var` fields or settable/virtual/computed properties.
  cs2gs's existing per-use `!!` insertion is untouched for that majority
  case, which this session's investigation did not find any sound
  translator- or language-level fix for.

## Alternatives considered

- **Do nothing; keep the cs2gs-side workarounds (status quo).** Leaves the
  28% same-method case permanently paying for a translator-side rewrite gsc
  itself could accept directly, and leaves the cross-method case (the worst
  single example in the corpus, 84 sites) with no fix at all, translator- or
  language-level. Rejected as leaving a measured, non-trivial gap
  permanently open when a sound subset is available.
- **Narrow all fields and properties, mutable included.** This is the
  option ADR-0069 already rejected and this ADR does not revisit that
  rejection — it is unsound for the reasons given there (another thread or
  override can change the value between the check and the use) and Kotlin
  does not do it either. Not proposed.
- **Require an explicit opt-in marker** (e.g. an attribute or keyword the
  author places on the field to request cross-method narrowing, similar in
  spirit to `[MemberNotNull]`/`[NotNullWhen]` from issue #208, or the
  receiver-contract attributes in ADR-0069's #4216 addendum). Considered as
  a middle ground for Tier 2 specifically, since it would let an author
  assert the invariant explicitly instead of asking gsc to re-derive it from
  constructor analysis. Not proposed as the primary mechanism, because the
  constructor-provable case (a field assigned unconditionally, non-null, on
  every constructor path) needs no assertion — the compiler can already see
  the proof, and making the user restate a fact the compiler can verify
  itself would be exactly the kind of `!!`-shaped ceremony this whole
  investigation is trying to remove. An opt-in attribute remains available
  as a *future* extension for the genuinely-lazy case Tier 2 declines (e.g.
  a `[MemberNotNull]`-style postcondition an author attaches to whichever
  method performs the real lazy initialization) — that is explicitly left
  as future work, not part of this proposal, because it requires
  cross-method call-order reasoning (has that method definitely run before
  this one?) that neither tier here attempts.
- **Narrow the whole type, keyed only on "some method somewhere guards
  this field"** (the naive reading of "the `viewModel` guard should apply
  everywhere"). Explicitly rejected in the Tier 2 discussion above — no
  ordering guarantee exists between instance methods, so this is unsound
  regardless of member mutability.
- **Fix it at the cs2gs (translator) level instead**: have cs2gs itself
  tighten a translated field's declared type from `T?` to `T` whenever
  Roslyn already proves every constructor path assigns non-null — the exact
  translator-side dual of Tier 2. Rejected as the primary mechanism for the
  same reason ADR-0155's A9 amendment gives for the opposite direction
  (`[AllowNull]` promotion): a declared contract should be decided by the
  declaration and provable by the compiler that owns the type, not inferred
  once at translation time and then frozen. A cs2gs-only fix helps nothing
  written directly in G#, and freezes the inference at migration time
  instead of re-checking it every time the type's constructors change. Tier
  2 as a gsc feature subsumes this cs2gs-level fix for free — once gsc
  proves the invariant itself, cs2gs's translated output benefits
  automatically alongside hand-written G#.

## Migration impact

Additive for the type-**acceptance** surface under gsc's own default
settings: this proposal can only accept programs the binder previously
rejected (a `!!` becomes optional, never required), never reject a program
that compiled before. That narrower claim is the one this ADR can actually
stand behind — it is not, and must not be read as, a claim that a program's
**binding or emitted behavior** is unchanged. Below are the two exceptions:
one where a currently-compiling program can newly fail to compile (build
configuration), and one where a currently-compiling program keeps compiling
but can silently resolve to different code (overload resolution).

**Overload resolution and implicit conversions can change for code that
still compiles.** Narrowing a member read changes its effective static
`Type` — that is the entire point of smart-cast narrowing, and ADR-0069
already says so directly ("Member lookup, overload resolution, conversion,
and emit all see `T`"). The binder consumes exactly that narrowed type when
ranking a narrowed read as a call argument: `ExpressionBinder.Calls.Arguments.cs`
computes `effectiveMemberType` from `BoundFieldAccessExpression.NarrowedType`
/ `BoundPropertyAccessExpression.NarrowedType` when present, and that
narrowed type — not the member's declared type — is what argument-ranking
and implicit-conversion classification see downstream. Consequently, a call
site passing a now-narrowed member as an argument to an overloaded method
can select a **different overload or a different implicit conversion** than
it did before this ADR, even though the program still compiles and even
though the newly-selected overload is itself accepted by the same
argument. For example, given
`func Handle(x ViewModel) { }` and `func Handle(x ViewModel?) { }` as two
overloads of the same name, a call `self.Handle(self.viewModel)` written
before adopting this ADR resolves to the `ViewModel?` overload (the field's
declared type); after adopting Tier 2 for a constructor-proven `viewModel`
field, the same call resolves to the `ViewModel` overload instead, because
the read's effective type at that call site is now non-nullable. If the two
overloads have different bodies — which is the entire reason a caller would
write two overloads instead of one — the program's **observable behavior
changes silently**, with no diagnostic, for source that is not modified at
all. This is not a new category of risk this ADR invents: ADR-0069 already
accepted the identical risk for local-variable and single-branch member
narrowing, and it has not been a reported problem there. But it is real,
and the migration-impact framing must say so rather than imply narrowing is
inert outside the accept/reject boundary. Authors relying on overload
resolution to distinguish nullable-vs-non-nullable call sites — an unusual
but not unheard-of pattern — are the ones who should audit call sites
touched by this ADR's newly-narrowed reads before adopting it broadly.

`GS0536` ("Redundant `!!`: the value is already non-null here.",
`DiagnosticDescriptors.RedundantNullAssertion`) already fires whenever a
`!!` is applied to an operand the binder can already prove non-nil — this is
the existing mechanism, not a new one this ADR would add. Adopting Tier 1 or
Tier 2 means some `!!` sites that are non-redundant *today* (because gsc
cannot yet see the member as narrowed) would become redundant, and would
newly report `GS0536` at those sites. `GS0536` is a **warning**, not an
error, in gsc's default diagnostic configuration — but gsc has a fully
implemented `/warnaserror` / `/warnaserror+:<ids>` / `/warnaserror-:<ids>`
switch (`src/Compiler/Program.cs`, the `warnaserror` argument-parsing case),
and the G# MSBuild SDK forwards the standard MSBuild
`TreatWarningsAsErrors` / `WarningsAsErrors` / `WarningsNotAsErrors`
properties from **any G# project** straight into that switch
(`src/Sdk/Gsharp.NET.Sdk/BuildTask.cs`, `Gsharp.NET.Core.Sdk.targets`).
`TreatWarningsAsErrors=true` on a G# project is an ordinary, common
setting, not an exotic one, and this repo has already hit exactly this
failure mode in production: `test/Sdk.Tests/Issue3782WarningsNotAsErrorsTests.cs`
documents that cs2gs's own redundant-`!!` polish loop needed a
`WarningsNotAsErrors=GS0536` carve-out specifically because GS0536 under
`TreatWarningsAsErrors=true` breaks the build. Any G# project author who has
set `TreatWarningsAsErrors=true` without that specific carve-out would see
previously-clean `!!` sites — sites that compiled warning-free before this
ADR — newly **fail the build** after adopting it, once gsc's improved
narrowing makes those assertions redundant. That is a real, already-
precedented exception to "purely additive," not a hypothetical one.

The practical mitigation is the same either way: this should be called out
explicitly in the implementing PR's description (with a pointer to the
`WarningsNotAsErrors=GS0536` carve-out precedent), and ideally paired with
an automated pass (an analyzer fix-it, or a one-shot codemod) that strips
exactly the `!!` sites the new narrowing makes redundant, rather than
leaving that cleanup — or the carve-out — to hand-editing at each affected
project.

No new diagnostic ID is required by this proposal. No syntax changes.

## Open questions for the implementer / reviewer

- Should Tier 2's constructor-invariant proof also cover a `let` field or
  get-only property assigned unconditionally in *every* constructor overload
  of a type with more than one `init(...)` declaration, or only a type with
  a single constructor? Multiple constructors complicate the "proved on
  every path" analysis but are not fundamentally different from the
  single-constructor case if each is checked independently. (This is
  unrelated to the get-only/`init`-only *accessor* distinction established
  above — Tier 2 never reaches an `init`-only property regardless of how
  many constructors the declaring type has; this question is only about how
  many `init(...)` constructor overloads a Tier-2-eligible `let`
  field/get-only property's own declaring type may have.)
- Whether Tier 1's relaxed call-invalidation should extend to a *mixed*
  path that has a mutable link *above* a CLR-enforced-stable one (a `let`
  field or no-setter property) reached through a different, unrelated
  receiver expression in the same call's reachable state — i.e. confirming
  the implementation keys invalidation on the member kind at each link, not
  on the call site alone, so a CLR-enforced-stable path through one
  receiver is unaffected by a call that could only reach a different,
  mutable-rooted (or `init`-only-rooted) path. This should fall out of
  applying the existing per-link `SmartCastStability` predicates, refined
  by this ADR's get-only/`init`-only split, rather than needing new
  machinery, but is worth confirming during implementation.
- Confirming, against the actual Oahu corpus, whether the `viewModel` field
  is a Tier-2-eligible constructor invariant or a genuinely lazy field is
  necessary before claiming this ADR "fixes" all 84 of its sites — see
  *Impact* above.

## Recommendation

This is a proposal, not a decision. The author's recommendation, offered for
the repo owner to accept, reject, or modify: **accept Tier 1 outright** —
its window-widening is a mechanical generalization of already-accepted,
already-implemented machinery with no new soundness argument beyond what
#1180 already established, and its call-invalidation relaxation rests on
one new, narrow, and — after this revision — precisely CLR-scoped argument
(only members the CLR itself makes immutable survive a call) — and
**accept Tier 2 pending confirmation against the real
corpus** that the constructor-invariant shape it targets actually matches
enough of the cross-method `!!` sites item 3 found to be worth the
`this`-escape analysis it requires — if the corpus's worst offenders turn
out to be genuinely-lazy fields rather than constructor invariants, Tier 2
should be re-scoped or deferred in favor of the opt-in-attribute alternative
noted above.
