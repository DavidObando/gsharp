# ADR-0183: Narrow immutable (`let`) fields and get-only auto-properties across statements within a method

- **Status**: Proposed
- **Date**: 2026-09-17
- **Amends**: ADR-0069 (Kotlin-style smart cast flow narrowing) — specifically
  the #1180 addendum's restriction of member-path narrowing to a single
  guarded branch, and that addendum's blanket "any intervening call
  invalidates every member-bearing path" rule.
- **Related**: ADR-0001 (null model), ADR-0067 (fields require `var`/`let`),
  ADR-0068 (`deinit` destructor support), ADR-0100 (`default(T)` and struct
  zero-initialization), ADR-0155 (incremental nullable adoption); issue
  #4262 (cs2gs nullability investigation) and its items 1 (#4277), 2
  (#4280), and 3 (audit of the `viewModel` cross-method case);
  `SmartCastStability` (`src/Core/CodeAnalysis/Binding/SmartCastStability.cs`)

> **Scope note.** An earlier draft of this ADR proposed a second tier —
> cross-method narrowing driven by a constructor-established invariant.
> Three review rounds found six independent soundness holes in it, and the
> last of them showed that a *fully corrected* version would not have covered
> the real-world case it was proposed to solve. That tier is **withdrawn**;
> its analysis is preserved below as [Explored and withdrawn](#explored-and-withdrawn-cross-method-constructor-proven-narrowing)
> with an itemized proof-obligation list, because the itemization is the most
> useful part of it. **What this ADR proposes is the single, bounded,
> within-method change described under [Decision](#decision-proposed).**

## Context

ADR-0069 gave gsc Kotlin-style smart-cast narrowing for locals and
parameters, and its #1180 addendum extended narrowing to **stable
member-access paths** (`b.Pet`, `o.Box.Pet`) — but only *within the single
guarded branch or block* where the test and the use appear together, and it
drops that narrowing on *any* intervening call. The original ADR declined to
narrow fields and properties more broadly for a reason that still holds in
general: "a field or property read is not idempotent (another thread or a
`deinit` could change it), so narrowing across two reads is unsound."
Kotlin makes the identical call for `var` properties, for the identical
reason.

That caution was never differentiated by field mutability, and this
session's cs2gs work shows the cost. Issue #4262's investigation
instrumented a real migrated corpus (Oahu) and found that, across 787
in-method `!!` sites, **220 (28%) have a null-guard on the same field or
property earlier in the same method** — gsc cannot carry the narrowing
across the statement boundary, so cs2gs re-asserts `!!` at every dereference
Roslyn had already proven safe. Item 2 (PR #4280) shipped a cs2gs-side
workaround: when a guard and its uses share one method and the member is
genuinely immutable, cs2gs captures it into a local right after the guard so
gsc's own local-narrowing carries it.

The workaround exists only because gsc will not do this itself. This ADR
proposes that gsc do it — for the cases where the CLR, not merely a
cooperating compiler, guarantees the value cannot change.

## Why ADR-0069's concern does not block every member

ADR-0069's objection is about **mutability**, not "fields versus locals":
the risk is that another thread or a computed getter changes the value
between the check and the use. That risk has two independent sources:

1. **The storage can be reassigned.** A `var` field, or a settable/virtual
   property, can have its value replaced after the guard ran. Narrowing
   across such a reassignment is unsound — Kotlin's rule for `var`
   properties, and G# should keep declining it exactly as ADR-0069 decided.
2. **The read is not idempotent.** A custom getter can return a different
   value on every call even with no reassignment. Two reads are not the same
   fact.

A **`let`-declared instance field** and a **genuinely get-only
(no-setter), non-virtual, non-overridable auto-property** are immune to both
by construction:

- Source 1 does not apply: `DeclarationBinder.Structs.cs` constructs an
  auto-property's backing field with `isReadOnly: !hasSetter` (the instance
  path near line 1807 and the `shared` path near line 2820), so a
  no-setter property's backing field is emitted `initonly`, exactly like a
  `let` field. The CLR itself rejects a write to `initonly` storage outside
  the declaring constructor — this is runtime enforcement, not a compiler
  convention.
- Source 2 does not apply: an auto-property has no custom getter body, so
  the read is a plain field load.

**An `init`-only auto-property (`{ get; init; }`) does not have this
guarantee.** `hasSetter` is `true` for an `init` accessor, so the same
`isReadOnly: !hasSetter` line gives its backing field `isReadOnly: false` —
an ordinary, CLR-mutable field. The `init` accessor is an ordinary setter
method distinguished only by an `IsExternalInit` `modreq`
(`MemberDefEmitter.cs`, near lines 486-491 and 1853-1855) that a *conformant
compiler* checks at the call site. Foreign IL, a non-conforming compiler, or
a codegen tool that does not model `modreq(IsExternalInit)` can call
`set_Foo(value)` after construction with no CLR-level objection. That is a
materially weaker bar than the reflection-based `FieldInfo.SetValue` bypass
this document treats as out of scope for `readonly` fields — calling an
ordinary method requires no special API at all.

This distinction is load-bearing for one half of the proposal below and not
the other, so the Decision separates them.

## Decision (proposed)

Two independent relaxations of the #1180 addendum, both confined to a single
method body:

### 1. Window-widening — applies to every `SmartCastStability`-stable member

Within one method body, a nil-guard or type-test on a stable member path
narrows that path for the remainder of the method's reachable,
non-invalidated flow, rather than only inside the guarded block. This
applies to `let` fields, get-only auto-properties, and `init`-only
auto-properties alike (`SmartCastStability.IsStableField` /
`IsStableProperty` decide stability, unchanged).

This half needs no new soundness argument *about mutation*. It never has to
reason about a call: every existing invalidation trigger (#1180's
intervening call, member/indexed assignment, and loop back-edge rules) stays
exactly as it is. The only change is that leaving the guarded block is no
longer *itself* an invalidation event when nothing invalidating happened.

It does, however, inherit — and enlarge — an existing **reachability**
defect, which this ADR must not gloss over.

> **Prerequisite: `goto` label reachability (pre-existing gsc defect,
> tracked as issue #4285).**
> gsc's early-exit narrowing lift does not account for a `goto` that jumps
> *past* the guard into the narrowed region. Compiled and run with the
> in-tree `gsc`:
>
> ```gs
> class ViewModel { func Refresh() { Console.WriteLine("refreshed") } }
> class Session {
>     let viewModel ViewModel?
>     func Setup(skip bool) {
>         if skip { goto after }
>         if this.viewModel == nil { return }
> after:
>         this.viewModel.Refresh()     // accepted; narrowing survives the bypass
>     }
> }
> let s = Session()
> s.Setup(true)
> ```
>
> This compiles with no diagnostic and throws
> `System.NullReferenceException` at runtime — precisely the failure the
> null model exists to prevent. The defect is **not introduced by this ADR**
> (it is reachable today through the shipped early-exit lift), and it
> corroborates the `goto` hazard PR #4280 recorded when it noted that gsc
> "does not reject this the way C#'s CS0159 would." But window-widening
> enlarges the span of statements a label can sit in, so it enlarges the
> exposure. **Implementing this ADR should be gated on the narrowing pass
> accounting for label reachability** — a narrowing must not survive to a
> label that is reachable from a `goto` outside the narrowed region. This
> should be filed and fixed as its own defect regardless of whether this ADR
> is accepted.

### 2. Call-invalidation relaxation — applies only to CLR-`initonly` storage

#1180 invalidates every member-bearing path on any intervening call,
"because a method could mutate reachable state." That is correct for a
`var` field, a settable/virtual property, **and an `init`-only property**
(a callee gsc did not compile — or anything it transitively calls — can
reach the `init` accessor as shown above; the method's bounded duration does
not defend against this, only the callee's provenance would, and gsc cannot
establish that).

It is unnecessarily conservative for storage the **CLR** makes immutable. No
callee, however foreign, can reassign `initonly` storage. So: a stable member
path **every link of which is CLR-`initonly`** (a `let` field, or a
no-setter auto-property) survives an intervening call. Any path with a
mutable link *or* an `init`-only link keeps today's blanket invalidation.

```gs
class ViewModel { func Refresh() { } }

class Session {
    let viewModel ViewModel?              // CLR-initonly storage

    func DoSomeUnrelatedWork() { }

    func Setup() {
        if this.viewModel == nil { return }
        this.DoSomeUnrelatedWork()        // ordinary call — does not invalidate
        this.viewModel.Refresh()          // proposed: accepted
    }
}
```

Today that final line reports `GS0159: Cannot call function Refresh because
receiver 'this.viewModel' may be nil` (verified by compiling this exact
snippet with the in-tree `gsc`). Under this proposal it binds without a
`!!`. An `init`-only `prop config Config? { get; init; }` in the same
position would still require the `!!` after the intervening call, and would
benefit only from the window-widening half.

> **Syntax note for readers of older ADRs.** G#'s explicit receiver keyword
> is `this`, not `self`. Several existing ADR examples (including ADR-0069's
> #2442 addendum) use `self.`, which does not bind — `self` is parsed as a
> type name and reports "Cannot find type self." All examples in this
> document were compiled with the in-tree `gsc` before being included.

## Explored and withdrawn: cross-method, constructor-proven narrowing

An earlier draft proposed a second tier: when a `let` field is declared
nullable (`let viewModel ViewModel?`) but the constructor provably assigns a
non-null value on every path, narrow the field's *declared* type for every
read outside the constructor — closing the cross-method case item 3 found
(a field named `viewModel`, 84 forced `!!` sites, where the guard and the
uses live in different methods and no cs2gs-level rewrite can reach them).

**This tier is withdrawn.** The decisive reason is not that it is expensive
to make sound — it is that a sound version would not cover the motivating
case:

> ADR-0069 already states, for its own back-edge proof: *"Parameters are not
> proof because a caller can pass a runtime-null value through a statically
> non-null field."* The withdrawn tier's own worked example was
> `init(vm ViewModel) { this.viewModel = vm }` — a parameter-sourced
> assignment, therefore **not** a proven-non-null assignment under the very
> ADR this document amends. Item 3's audit reports the real `viewModel` field
> is assigned the same way (`this.viewModel = viewModel` in a
> `MainWindow(MainWindowViewModel viewModel, …)` constructor). A
> correctly-specified version of this tier would decline both.

So the tier, fixed, is close to vacuous for the corpus that motivated it.
That is the finding worth recording.

The structural reason it kept failing review is also worth recording: the
tier tried to prove a **whole-program, whole-lifetime, unbounded** invariant
("non-null at every read, in every method, forever, including from code gsc
never compiled") out of **local syntactic evidence** (what one constructor's
source looks like). Each review round closed one enumerated hole and the next
round found another, because the enumeration is not closed — it must quantify
over every way a CLR object can come into existence, every subclass, every
finalizer, and every foreign caller. The proposed change that survived, by
contrast, proves a *local, bounded* fact between two points in one method
body over a closed set of intervening operations.

### Proof obligations for any future attempt

A future proposal in this space must discharge all of the following. Each
was surfaced by review of the withdrawn tier.

1. **Constructor-bypass allocation.** A constructor-established invariant
   assumes every instance ran a constructor. For structs, ADR-0100's
   field-wise zero-initialization (`initobj`, `default(T)`, array
   allocation, a struct field nested in another struct) bypasses every user
   constructor. For **reference types**, `RuntimeHelpers.GetUninitializedObject`
   / `FormatterServices.GetUninitializedObject` do the same, leaving
   `initonly` fields at their zero value. These are routine in serializers
   and ORMs, not exotic. Either exclude such instances from the model
   explicitly, or account for them; restricting to `class` does not help.
2. **Base-constructor observation of `this`.** The emitter invokes the base
   constructor *before* any derived field store —
   `src/Core/CodeAnalysis/Emit/ConstructorBodyEmitter.cs` emits
   `LoadArgument(0)` + `Call baseCtorToken` at lines 559-567 (primary-ctor
   path) and 688-698 (explicit `init(...)` path), with positional field
   stores at 569-588 and field initializers at 590-602 / 710-723, and the
   user body last at 726-735. A user-written or *imported* base constructor
   can therefore retain or inspect `this` while the derived field is still
   nil, with no virtual call on `this` anywhere in the derived source. The
   escape-analysis checklist must cover the implicit `base(...)` call.
3. **Derived-type finalizers.** Checking that the declaring class and its
   *base* chain declare no `deinit` is insufficient: an `open` class can be
   subclassed by a type that declares one (ADR-0068 permits `deinit` on any
   class). If a base constructor throws before the field's store, the CLR
   can finalize the partially-constructed derived instance and that `deinit`
   reads the inherited field as nil. This needs a sealed/type-local
   restriction or a hierarchy-wide guarantee; the syntactic base-chain check
   cannot prove it.
4. **`init`-setter reachability from foreign IL.** As established above, an
   `init`-only property's backing field is not `initonly` and its accessor is
   an ordinary method. Any whole-lifetime claim must exclude `init`-only
   members or prove the type never escapes to code gsc did not compile.
5. **No existing analysis can discharge the proof.** The withdrawn draft
   claimed the tier "piggybacks on" gsc's existing `let`-field
   definite-assignment pass. **That claim is false.**
   `DefiniteAssignmentAnalyzer` tracks non-`out` parameters, `out`
   parameters (GS0238), and a narrow set of locals (GS0522); its entire
   lattice is a `HashSet<VariableSymbol>`, and `FieldSymbol` does not derive
   from `VariableSymbol`, so a field can never enter it. Read-only fields are
   touched only by `IsReadOnlyFieldAssignmentAllowed`
   (`src/Core/CodeAnalysis/Binding/ExpressionBinder.Assignments.cs`, ~334-370),
   which decides whether a write is *legal* in a constructor — never whether
   every path performs one, and never the assigned value's null state. No
   pass in gsc today proves "every constructor path assigns a non-null final
   value to this field." A new constructor CFG with value/null-state
   tracking would be required.
6. **Parameter-sourced assignment is not proof** (ADR-0069, quoted above) —
   the obligation that makes the tier moot for the motivating corpus. A
   future attempt must define its proof in terms of genuinely
   proven-non-null expressions (fresh constructor results, literals,
   already-proven values) and accept that constructor parameters, imported
   call results, and unproved function results do not qualify.

### Recommended successor for the cross-method case

Because the obstacle is the *unbounded compile-time proof*, the promising
direction is to stop attempting one. An **author-asserted, runtime-checked
postcondition** — a `[MemberNotNull]`-style attribute in the spirit of issue
#208 and ADR-0069's #4216 receiver contracts — sidesteps every obligation
above: the author states the invariant, gsc trusts the declaration at read
sites, and the assertion is checked once where the author says it holds
rather than re-derived from whole-program analysis. That is a separate ADR,
but it is the successor this document recommends for the 84-site class of
case, in preference to another attempt at inferring the invariant.

## Impact

- **The 220 same-method sites (28% of in-method `!!`).** For the
  CLR-`initonly` subset (`let` fields, get-only properties), both halves of
  the Decision apply and gsc accepts these programs directly, regardless of
  intervening calls — which lets #4280's local-capture rewrite be simplified
  or retired for that subset, since cs2gs would stop inserting `!!` there in
  the first place. For `init`-only properties, only window-widening applies:
  guard/use pairs with no intervening call are covered, and pairs separated
  by a call still need #4280's capture or a per-use `!!`. The corpus split
  between those two shapes has not been measured and should be, before
  claiming a specific share of the 220.
- **The 84-site `viewModel` case is not addressed by this ADR.** The
  withdrawn tier was its only proposed route, and the parameter-sourcing
  obligation above means a corrected version would not have reached it
  either. It remains open, with the attribute route recommended.
- `var` fields and settable/virtual/computed properties are untouched;
  cs2gs's per-use `!!` remains correct for them.

## Alternatives considered

- **Do nothing; keep the cs2gs-side workarounds.** Leaves the same-method
  case permanently paying for a translator rewrite gsc could accept
  directly. Rejected for the CLR-enforced subset, where the soundness
  argument is short and checkable.
- **Narrow all fields and properties, mutable included.** The option
  ADR-0069 rejected; unsound for the reasons given there. Not proposed.
- **Narrow `init`-only members across calls too.** Rejected — see obligation
  4; this was a defect in an earlier draft of this document, not a live
  option.
- **Narrow the whole type from a guard in some other method.** Rejected:
  instance methods have no ordering guarantee, so a guard in `Setup()`
  proves nothing at the entry to `Handle()`.
- **An explicit opt-in attribute.** No longer merely an alternative — it is
  the recommended successor for the cross-method case (above). It is not a
  substitute for this ADR's within-method change, which needs no author
  annotation because the compiler can see the whole flow.
- **Fix it in cs2gs by tightening declared types.** Rejected for the reason
  ADR-0155's A9 gives for the mirror case: a declared contract should be
  decided by the declaration and checked by the compiler that owns the type,
  not inferred once at translation time and frozen. It also helps nothing
  written directly in G#.

## Migration impact

Narrowing changes a read's effective static type, and ADR-0069 already says
what follows: "Member lookup, overload resolution, conversion, and emit all
see `T`." The binder consumes the narrowed type when ranking call arguments —
`ExpressionBinder.Calls.Arguments.cs` (~602-608) derives `effectiveMemberType`
from `BoundFieldAccessExpression.NarrowedType` /
`BoundPropertyAccessExpression.NarrowedType` when present. Widening *where*
narrowing applies therefore has consequences beyond accept/reject, and the
"purely additive" framing used in earlier drafts of this document was wrong
in two verified ways.

**1. Overload selection can change silently.** Both programs below were
compiled and run with the in-tree `gsc`; the flip uses #1180's
already-shipped single-branch member narrowing, so it is current behavior,
not a hypothetical:

```gs
class ViewModel { }
class Host { let Current ViewModel? }

func Handle(x object?) string { return "object? overload" }
func Handle(x ViewModel) string { return "ViewModel overload" }

func Describe(h Host) string {
    let wide = Handle(h.Current)          // -> "object? overload"
    var narrow = "<none>"
    if h.Current != nil {
        narrow = Handle(h.Current)        // -> "ViewModel overload"
    }
    return wide + " / " + narrow
}
```

Printed output: `object? overload / ViewModel overload`. The mechanism:
`ViewModel? → ViewModel` is an *explicit* (bang-requiring) conversion in
G#'s null model, so at the un-narrowed site `Handle(ViewModel)` is not
applicable at all and `Handle(object?)` is the sole candidate; once narrowed,
`ViewModel → ViewModel` is an Identity conversion and outranks the Reference
conversion to `object?`. Extending narrowing to more sites extends this
flip to more sites. Two overloads with different bodies will silently
dispatch differently for unmodified source.

**2. A previously-compiling call can become ambiguous.** This is a genuine
compatibility break, not merely a behavior change:

```gs
class Host {
    let n int32?
    func Handle(x int32) { }
    func Handle(x int32?) { }
    func Run() {
        this.Handle(this.n)        // binds today: picks Handle(int32?)
        if this.n != nil {
            this.Handle(this.n)    // GS0266: ambiguous between overloads
        }
    }
}
```

Compiled with the in-tree `gsc`, the first call binds and the guarded call
reports `GS0266: Call to 'Handle' is ambiguous between multiple overloads`.
Narrowing `int32? → int32` makes *both* overloads applicable where only one
was before. `int32` and `Nullable<int32>` are genuinely distinct CLR types,
so this overload set is legitimate — the ambiguity is real and the error is
new. Any site this ADR newly narrows can hit this. **The claim "no program
that compiled before fails to compile after" is therefore false**, and the
implementing PR must survey for it rather than assert additivity.

> **Aside (separate defect, not caused by this ADR).** For *reference*
> types, `T` and `T?` share a CLR type — `NullableTypeSymbol` passes the
> underlying type's `ClrType` straight through — yet gsc accepts
> `func Handle(x ViewModel)` alongside `func Handle(x ViewModel?)` and emits
> two `MethodDef` rows with identical name and signature, which ECMA-335
> forbids. Verified by reflecting over the emitted assembly: both appear as
> `Handle(ViewModel)`. Overload identity compares type *display names*
> (`BoundScope`'s signature comparison), so `"ViewModel?" != "ViewModel"` and
> the duplicate-signature diagnostic never fires. This is worth its own
> issue; it is noted here only because such a pair looks like a natural
> example for the overload discussion above and must not be used as one.

**3. `GS0536` (redundant `!!`) can fail builds.** Some `!!` sites that are
non-redundant today become redundant and newly report `GS0536` ("Redundant
'!!': the value is already non-null here.",
`DiagnosticDescriptors.RedundantNullAssertion`). It is a warning by default,
but gsc implements `/warnaserror` / `/warnaserror+:` / `/warnaserror-:`
(`src/Compiler/Program.cs`) and the SDK forwards MSBuild's
`TreatWarningsAsErrors` / `WarningsAsErrors` / `WarningsNotAsErrors` into it
(`src/Sdk/Gsharp.NET.Sdk/BuildTask.cs`,
`Gsharp.NET.Core.Sdk.targets`). This repo has already hit exactly this:
`test/Sdk.Tests/Issue3782WarningsNotAsErrorsTests.cs` records that cs2gs's
own redundant-`!!` polish loop needed a `WarningsNotAsErrors=GS0536`
carve-out. A G# project with `TreatWarningsAsErrors=true` and no carve-out
will fail to build until the now-redundant assertions are removed.

The mitigation for all three: the implementing PR should ship a codemod or
analyzer fix-it that strips the newly-redundant `!!`, and should compile a
representative corpus to surface (1) and (2) rather than assuming they are
rare.

## Open questions for the implementer / reviewer

- Measure the corpus split between CLR-`initonly` members and `init`-only
  members among the 220 same-method sites, so the benefit claim is sized
  rather than asserted.
- Confirm the implementation keys call-invalidation on the member kind at
  *each link* of a path, so a CLR-`initonly` path through one receiver is
  unaffected by a call that could only reach a different, mutable-rooted
  path. This should fall out of the existing per-link predicates plus the
  get-only/`init`-only split, but is worth a test.
- Decide whether the GS0266 ambiguity regression (Migration impact 2)
  warrants a dedicated diagnostic or migration note, given it converts
  working code into a build error.
- File the duplicate-`MethodDef` defect noted in the Migration impact aside
  as its own issue; it is independent of this ADR.
- ~~File the **`goto`-bypasses-narrowing defect** demonstrated under
  *Window-widening* as its own issue.~~ Filed as **issue #4285**
  (independently reproduced against in-tree `gsc`). It is a live, silent
  `NullReferenceException` in shipped gsc, independent of this ADR, and it
  is a prerequisite for the window-widening half rather than a consequence
  of it.

## Recommendation

Offered as a proposal for the repo owner to accept, reject, or modify:

1. **Accept the within-method change** (both halves of the Decision),
   **gated on the `goto`/label-reachability fix**. The window-widening half
   is a mechanical generalization of shipped machinery, but it enlarges an
   existing reachability hole that is already a silent NRE and should be
   closed first. The call-invalidation half rests on one narrow, checkable
   argument — only storage the CLR itself makes immutable survives a call —
   and the get-only/`init`-only split keeps it honest.
2. **Treat the cross-method tier as withdrawn**, with the six proof
   obligations above as the entry price for any future attempt. Its
   motivating case is not reachable by a correct version of it.
3. **Pursue the opt-in postcondition attribute** as the successor for the
   cross-method case, in a separate ADR.
4. **Do not describe this change as purely additive.** Two verified
   compatibility effects (overload flip, new GS0266 ambiguity) plus the
   GS0536 build interaction should be surveyed on a real corpus as part of
   implementation.
