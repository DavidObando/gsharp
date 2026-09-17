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

A **`let`-declared instance field** (emitted `initonly`/`readonly`) and a
**get-only, non-virtual, non-overridable auto-property** are immune to
*both* sources by construction, not by convention:

- Source 1 does not apply: `let` fields cannot be reassigned after the
  constructor that initializes them runs — the CLR enforces this at the IL
  level (`initonly`), and ADR-0067 already makes this the only spelling for
  an immutable field. A get-only auto-property with no setter (or an
  `init`-only setter) has the identical guarantee, transitively, because it
  is backed by exactly such a field.
- Source 2 does not apply: an auto-property has no custom getter body — the
  read is a plain field load, which is trivially idempotent. (This is
  exactly the `IsStableProperty` predicate `SmartCastStability` already
  uses for #1180's single-branch member narrowing — this ADR does not
  invent a new stability test, it widens the *scope* over which an
  already-accepted stability test may be trusted.)

So the concern ADR-0069 raised is real, but it is a concern about `var`
fields and computed/virtual properties, not about `let` fields and get-only
auto-properties. This ADR proposes to keep declining the former
unconditionally (no change from ADR-0069) and to widen the scope for the
latter from "single guarded branch" to a scope precise enough to close the
`viewModel`-shaped gap, argued case by case below.

## Decision (proposed)

**Narrow a `let`-declared instance field, or a non-virtual/non-overridable
get-only (or `init`-only) auto-property — a *stable member*, exactly
`SmartCastStability.IsStableField` / `IsStableProperty` today — across
statement boundaries within the enclosing method, and lift the narrowing
across method boundaries only through the object's constructor-established
invariants, never through a same-object guard performed by another,
unrelated method call.**

Concretely, this ADR proposes two scope tiers, argued separately because
their soundness arguments are different:

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

That blanket call-invalidation rule is exactly right for a `var` field or a
settable/virtual property, where a callee genuinely could reassign the
storage or override the getter. It is unnecessarily conservative for a
`let` field or get-only auto-property: no callee, however arbitrary, can
reassign `initonly` storage or intervene in a getter that has no custom
body. This ADR therefore proposes relaxing call-invalidation specifically
for stable member paths (every link `IsReadOnly`/`IsStableProperty`) — such
a path survives an intervening call unless the call assigns to the path
itself (which cannot happen for `initonly` storage) — while leaving the
existing blanket invalidation exactly as-is for any path with a mutable
link. Combined with dropping the "single guarded block only" restriction
for stable paths, this is what lets Tier 1 actually reach the 220 same-method
sites item 2 measured, most of which have ordinary work between the guard
and the use.

```gs
class Session {
    let viewModel ViewModel?

    func Setup() {
        if self.viewModel == nil { return }
        DoSomeUnrelatedWork()          // ordinary call — does not invalidate
        self.viewModel.Refresh()       // accepted — viewModel still narrowed
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
a flow fact borrowed from one method's guard.

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
honest boundary. Tier 1 is unaffected by this restriction — its
call-invalidation relaxation is a per-read flow fact, not a claim about
every possible instance of the type, and structs are not excluded from it.

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
  same-method guard on the underlying field/property. Tier 1 would let gsc
  itself accept these programs directly — no `!!` needed at any of those
  sites — which lets #4280's local-capture rewrite be **simplified or
  retired for the `let`/get-only-property subset** of what it currently
  handles: cs2gs would simply stop inserting `!!` there in the first place,
  the same way it already stops for a plain narrowed local. #4280's
  mutable-member fallback path (settable/virtual members, name collisions,
  loop-carried writes, closures, `goto`) is unaffected — Tier 1 only ever
  helps the already-`IsStableMemberSymbol`-eligible subset, which is exactly
  the subset #4280 restricts its own capture rewrite to.
- Item 3's `viewModel` example (84 forced `!!` sites, cross-method) is the
  case no cs2gs-level fix could reach. Whether Tier 2 closes it depends on
  three separate facts about that codebase, none of which this ADR can
  settle in the abstract: whether the declaring type is a `class` (Tier 2
  does not apply to a `struct`/`data struct`/`inline struct` at all — see
  the scoping above), whether that type or any base class declares `deinit`
  (which would also disqualify it), and whether the constructor actually
  proves the field non-null on every path (the original caveat). If all
  three hold, Tier 2 closes the entire cluster; if the field is genuinely
  lazily-initialized post-construction, is declared on a struct, or sits on
  a `deinit`-bearing type, none of the tiers proposed here help it, and that
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

Additive for the type-acceptance surface under gsc's own default settings:
every program that binds today continues to bind identically, and this
proposal can only accept programs the binder previously rejected (a `!!`
becomes optional, never required). But this has one real, already-
encountered exception, described below — "no program that compiled before
would fail to compile after" is not unconditionally true.

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

- Should Tier 2's constructor-invariant proof also cover a field assigned
  unconditionally in *every* `init`/factory-constructor overload (mirroring
  how #1180's stable-property rule already treats "no setter, or `init`-only
  setter" as one case), or only a type with a single constructor? Multiple
  constructors complicate the "proved on every path" analysis but are not
  fundamentally different from the single-constructor case if each is
  checked independently.
- Whether Tier 1's relaxed call-invalidation should extend to a *mixed*
  path that has a mutable link *above* a stable one reached through a
  different, unrelated receiver expression in the same call's reachable
  state — i.e. confirming the implementation keys invalidation on the
  member kind at each link, not on the call site alone, so a stable path
  through one receiver is unaffected by a call that could only reach a
  different, mutable-rooted path. This should fall out of applying the
  existing per-link `SmartCastStability` predicates rather than needing new
  machinery, but is worth confirming during implementation.
- Confirming, against the actual Oahu corpus, whether the `viewModel` field
  is a Tier-2-eligible constructor invariant or a genuinely lazy field is
  necessary before claiming this ADR "fixes" all 84 of its sites — see
  *Impact* above.

## Recommendation

This is a proposal, not a decision. The author's recommendation, offered for
the repo owner to accept, reject, or modify: **accept Tier 1 outright** (it
is a mechanical generalization of already-accepted, already-implemented
machinery with no new soundness argument beyond what #1180 already
established), and **accept Tier 2 pending confirmation against the real
corpus** that the constructor-invariant shape it targets actually matches
enough of the cross-method `!!` sites item 3 found to be worth the
`this`-escape analysis it requires — if the corpus's worst offenders turn
out to be genuinely-lazy fields rather than constructor invariants, Tier 2
should be re-scoped or deferred in favor of the opt-in-attribute alternative
noted above.
