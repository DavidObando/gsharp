# ADR-0186: Platform types (`T!`) for nullability-oblivious CLR interop

- **Status**: Proposed
- **Date**: 2026-09-18
- **Phase**: Phase 9 — null model / CLR interop
- **Amends**: [ADR-0136](0136-nullable-by-default-for-unannotated-imports.md) — §2's
  *oblivious* row (an unannotated imported reference position becomes `T!`, not
  `T?`) and §3's emit rule (an oblivious declaration emits oblivious metadata
  rather than being forced into the annotated shape). ADR-0136's central claim —
  *a reference type the compiler admits as non-null must genuinely be non-null,
  and oblivious must never silently mean non-null* — is preserved and
  strengthened, not reversed. Only the type oblivious maps **to** changes.
- **Related**: [ADR-0001](0001-null-model.md) (the Kotlin-style null model this
  extends), [ADR-0069](0069-smart-cast-flow-narrowing.md) (smart-cast narrowing),
  [ADR-0071](0071-if-let-and-guard-let-bindings.md) (`if let` / `guard let`),
  [ADR-0073](0073-null-conditional-indexing.md) (`?[`),
  [ADR-0115](0115-csharp-to-gsharp-migration-tool.md) (cs2gs),
  [ADR-0132](0132-nullable-array-element-spelling.md) (`[]T?` vs `[]?T`),
  [ADR-0154](0154-test-oracle-strength.md) (mutation witnesses),
  [ADR-0155](0155-incremental-nullable-adoption.md) (incremental nullable
  adoption; A9 on `[AllowNull]`),
  [ADR-0159](0159-magic-collection-zero-values-and-nil-comparison.md) (GS0523),
  [ADR-0160](0160-as-operator-yields-nullable.md) (`as` yields `T?`),
  [ADR-0175](0175-scoped-diagnostic-suppression.md) (annotations as G#'s
  directive mechanism); issues
  [#4287](https://github.com/DavidObando/gsharp/issues/4287),
  [#4310](https://github.com/DavidObando/gsharp/issues/4310),
  [#1354](https://github.com/DavidObando/gsharp/issues/1354),
  [#3501](https://github.com/DavidObando/gsharp/issues/3501); PR
  [#4308](https://github.com/DavidObando/gsharp/pull/4308) (`fix/4287-nullable-clr-instance-call-receiver`)

> ## Baseline: what is on `main`, and what is not
>
> **PR #4308 is closed and unmerged.** `git merge-base --is-ancestor
> origin/fix/4287-nullable-clr-instance-call-receiver origin/main` is false, and
> none of `IsImportedClrChainReceiver`, `ExtensionDeclaresNilableReceiver` or
> `ImportedReceiverParameterAdmitsNil` exists on `main`. The name
> `nullableInnerVt` *does* exist on main
> (`ExpressionBinder.Calls.Invocation.cs:3706`) but belongs to an unrelated
> value-type `Nullable<T>` path; the `IsValueType: false` block this ADR discusses
> is branch-only.
>
> **What `main` actually has** is a single-arm carve-out
> (`ExpressionBinder.Access.MemberLookup.cs:941–946`):
>
> ```csharp
> private static bool CanBindClrInstanceMember(BoundExpression? receiver)
> {
>     return receiver?.Type?.ClrType != null
>         && (receiver.Type is not NullableTypeSymbol
>             || receiver is BoundClrPropertyAccessExpression);
> }
> ```
>
> **This ADR is written against `main`**, and the structural diagnosis below is
> derived from that one-arm predicate. PR #4308's thirteen commits are cited
> throughout as *the evidence trail* — the catalogue of what each additional arm
> cost and what it broke — not as the code being edited. Where a section discusses
> deleting or keeping branch-only code, it is stated as conditional on that branch
> landing first; see *Implementation impact*, which gives both baselines.
>
> The diagnosis does not weaken under the correct baseline. A one-arm proxy for a
> metadata fact is still a proxy; PR #4308 is simply the measurement of how many
> arms it grows when pushed, and of what the growth costs.

## Context

### What ADR-0136 decided, and what it cost

ADR-0136 closed a real hole. Before it, a reference position arriving from an
unannotated (*oblivious*) assembly was imported as a non-null `T` the program
could not even null-check — the "platform type treated as non-null" trap
ADR-0136 itself names and rejects. The fix was to read every oblivious reference
position as `T?`, and then require the compiler to **prove** each use site safe
by G#'s ordinary means: `!!`, `if let`, `?.`, and ADR-0069 smart-cast narrowing.

That is a strong guarantee, and it is the right guarantee for a position whose
nullability is *known*. For a position whose nullability is *unknown* it is a
guarantee about a fact the compiler does not have. The proof obligation is
therefore discharged not by evidence but by a growing set of **carve-out
predicates** — hand-written answers to "is this particular receiver shape
exempt?" — and those predicates are what this ADR is about.

The measured cost of the proof obligation is in the self-migration gate. The
ratcheting baseline (`tools/cs2gs/selfmig-baseline.json`) caps the migrated
corpus at **`nullAssertionCeiling = 12100`** null assertions. Roughly twelve
thousand `!!` exist in the self-migrated tree, a large majority of them
discharging obligations on values whose nullability nobody ever stated. An
earlier baseline capped the same metric at 17,400; the number moves with corpus
size, never toward zero, because the obligation is structural.

And a `!!` in G# is not free. cs2gs's own source states the stakes, in the
comment on `IsImportedObliviousNullableTarget`
(`CSharpToGSharpTranslator.Nullability.cs:1596`): *"`x!!` is a RUNTIME assertion
in G# (it lowers to `dup; brtrue; pop; newobj NullReferenceException; throw`),
unlike C#'s erased `x!`"* — so a gratuitous assertion inserted to satisfy a proof
obligation turns a legal C# call into a crash that translate, compile and
ILVerify all pass. The current model already pays a runtime price; it simply pays
it at sites chosen by a guess rather than at boundaries chosen by a rule.

### The catalogue: PR #4308, thirteen commits, six failure modes

Issue #4287 reported a plain, unattributed `NullReferenceException`: a call to a
CLR instance method through a nilable receiver compiled with zero diagnostics.
The fix took thirteen commits on
`fix/4287-nullable-clr-instance-call-receiver`. Each round looked complete;
each time CI, the private `cs2gs-oahu` corpus, or an adversarial review found
another shape. The six are the mandatory test matrix for anything that replaces
this machinery.

| # | Commit | Failure mode |
| --- | --- | --- |
| 1 | `ea0cad22` | **Read and call paths drifted.** The read path (`CanBindClrInstanceMember`) had always carved out an oblivious CLR receiver mid-chain; the new call-path check had no equivalent. `Environment.Version.Major` compiled while `Environment.Version.ToString()` reported GS0159. Seven CI jobs and the self-migration hot core went down. |
| 2 | `a967928a` | **One translator branch forgot the helper.** In cs2gs, a generic instance call carrying explicit type arguments (`x.M<T>(...)`) has its own branch of `TranslateInvocationCore` that built its target with a bare `TranslateExpression`. Every sibling receiver position called `TranslateReceiverWithNullForgiveness`. `x.Parent` and `x.Plain()` were asserted; `x.Up<T>()` beside them was bare. |
| 3 | `db3b9422` | **A message-formatting detail gated the safety check.** The #4287 check ran only when there was receiver syntax available *to quote in the diagnostic message*. A chained call has none — the bound intermediate receivers are built with a null `Syntax`. So `s.ToUpper()` reported and `s.ToUpper().Trim()`, `s.ToUpper().Length`, `s.ToUpper()[0]` and `sb.Append("a").Append("b")` bound straight through. **The bug #4287 was filed about still shipped, in full, for every chained call.** Parenthesising the receiver "fixed" it. |
| 4 | `539d8c3a` | **A narrowing asymmetry with no principle behind it.** cs2gs assumed gsc narrows `X != nil && X.Contains(i)` for a member `X`. gsc narrows only the **qualified** form: `this.X != nil && this.X.Contains(i)` compiles, the identical bare `X` does not, for a readonly field and a get-only property alike, for reads exactly as for calls — the smart-cast frame is keyed by an `AccessPath` that an implicit-`this` reference never produces. Filed as issue #4310 and explicitly *not* fixed. |
| 5 | `359538cd` | **A silent miscompile, strictly worse than the crash.** The fix for (3) added an extension-method probe ahead of own-surface CLR lookup for any nilable receiver. It did not distinguish an extension *declared* to accept a nilable receiver from one merely *reachable* by implicit conversion. From one source line `xs.Reverse()`: a plain `List[int32]` receiver bound `List<T>.Reverse` (void, in place, first element `2`); a `List[int32]?` receiver bound `Enumerable.Reverse` (lazy, copying, result discarded, first element `1`). **Same line, opposite runtime meaning, chosen purely by the receiver's static nullability, with no diagnostic either way.** The same mechanism silently retyped `string?.Trim()` from `string` to `ReadOnlySpan<char>` via `MemoryExtensions`. |
| 6 | `81a9400d` | **A scope question the narrow fix could not answer.** Gating the probe on a *declared*-nilable receiver fixed (5) but split the newly-reported sites in two: where a competing instance member exists the gate prevents a miscompile (must fix); where none exists — `IEnumerable[T]?.Min()`, `List[int32]?.Count()` — the extension was the right method all along and only its receiver was unguarded, a *pre-existing* latent-throw class the new gate incidentally started flagging. |

### The structural diagnosis

Every one of the six is the same defect wearing different clothes. The
information the binder needs — *did this `?` come from an explicit G# annotation,
or from the absence of information in imported metadata?* — **is not in the
type**. `NullableTypeSymbol` cannot tell the two apart; its constructor takes
`underlyingType.ClrType` directly, so for an imported type its `ClrType` is
never null and the pre-#4287 fallback never fired. So the binder reconstructs
the answer from the *shape of the bound receiver node*. On `main` that
reconstruction is one arm:

```csharp
// ExpressionBinder.Access.MemberLookup.cs:941-946 (main)
return receiver?.Type?.ClrType != null
    && (receiver.Type is not NullableTypeSymbol
        || receiver is BoundClrPropertyAccessExpression);
```

`receiver is BoundClrPropertyAccessExpression` is a *proxy* for "this `?` came
from oblivious CLR metadata." It is a good proxy for the case it was written for
and silently wrong for every other node kind that carries the same fact. PR
#4308's first correction (failure mode 1) grew it to four arms —
`BoundImportedInstanceCallExpression`, `BoundImportedCallExpression`,
`BoundClrStaticCallExpression` — because a chained *call* result carries
metadata-origin nullability exactly as a property read does, and the one-arm
predicate could not see it.

That is the shape of the whole problem: the predicate is wrong whenever a new
node kind appears (failure mode 1), unavailable wherever the node has no syntax
(failure mode 3), and blind to the fact that the same path spelled differently is
the same path (failure mode 4). Nothing bounds the number of arms, because
nothing connects them — each is an independently-remembered answer to a question
the type could have answered once. The combinatorial surface is (every receiver shape) × (every
access kind: read, call, index, `foreach`, method group) × (every binding path:
own surface, inherited CLR, interface, extension, imported extension, delegate,
constrained), and there is no invariant tying the cells together — only
predicates added one bug at a time.

**Failure mode 5 is the one that settles the question.** Chasing the corner
cases did not merely fail to eliminate the crash; it produced a *silent
miscompile*, in which the receiver's static nullability — a property the source
never states and the metadata does not know — silently selects between two
methods with different runtime semantics. A system that converts missing
information into a wrong answer with no diagnostic is worse than one that admits
the information is missing.

### Kotlin's answer

Kotlin faces exactly this against unannotated Java and does not attempt the
proof at all. A value from an unannotated Java API gets a third type category,
the **platform type**, notated `T!` in diagnostics and tooling and not writable
in source. A platform type is usable as both `T` and `T?` without an operator;
the compiler **requires no proof** that a use is safe — a null check still smart-casts
a platform value, exactly as it does a nullable one, but it is a convenience and
never an obligation; and the safety question is deferred to the point where the
value is *used as non-null*, where a runtime assertion is inserted. If the Java
side *does* carry recognized
nullability annotations, Kotlin uses them for full static `T`/`T?` typing as
normal — platform types are specifically and only for the oblivious case.

The entire bug class chased in PR #4308 does not exist in that design: there is
no carve-out predicate to get wrong, no chain to track, no field-vs-property
distinction, no extension-vs-instance interaction — because nothing is being
proved.

### Two facts about gsc's emit that shape the design

**First: the runtime mechanism already exists.** `!!` lowers to a real check —
`dup; brtrue; pop; newobj NullReferenceException; throw`
(`MethodBodyEmitter.Operators.cs`) — so nothing new has to be invented to insert
one.

**Second: gsc's receiver-opcode selection is narrower than "reference type", and
that bounds what this design may assume.** The emitter chooses `callvirt` by
literal symbol-kind tests:

```csharp
var receiverIsClass = access.Receiver.Type is StructSymbol rs && rs.IsClass;
var receiverIsInterface = access.Receiver.Type is InterfaceSymbol;
```

A *wrapped* receiver type (`NullableTypeSymbol`, and so `PlatformTypeSymbol`)
fails both, as do `string`, `Array`, and imported types that are not
`StructSymbol{IsClass:true}`. Several families therefore emit `call` — or `ldftn`,
which is worse — and perform no receiver nil check at all. An earlier draft of
this ADR built a receiver *exemption* on the assumption that the CLR always
checks; §4 records that claim, its falsification, and the honest rule that
replaces it. The short version: the check goes in at every coercion including
receivers, and the CLR's own check is a reason to **elide** where it provably
fires, not to specify an exemption.

## Decision

Adopt Kotlin's model. A nullability-**oblivious** imported reference position
gets a third type category, the **platform type** `T!`. G#'s own `T?` and
everything built on it is untouched.

### 1. `T!` is a real, distinct, unspellable type symbol

`PlatformTypeSymbol` is a new `TypeSymbol` wrapper, cached and shaped exactly
like `NullableTypeSymbol` (`PlatformTypeSymbol.Get(underlying)`, an
`UnderlyingType` property, `ClrType == underlying.ClrType`, erased at emit). It
is a **real type in the binder**, not a flag and not an erasure:

- **Not a flag on `NullableTypeSymbol`.** A flag preserves exactly the defect
  this ADR exists to remove: every site that today asks "is this `?` from
  metadata?" would still have to ask, just with a better oracle. Making it a
  distinct symbol means the sites that must not treat it as nullable — member
  lookup, overload resolution, GS0159 — simply never match
  `is NullableTypeSymbol`, and do so **by construction**, not by remembering to
  check.
- **Not an erasure to `T`.** `T!` must admit `== nil`, `if let`, `?.` and `!!`
  (see §6). Erasing to `T` would re-create ADR-0136's original hole verbatim.

**It is never writable in source.** No syntax produces a `PlatformTypeSymbol`.
It is produced by exactly one mechanism (§2) and appears only in diagnostics,
hover text, and `DisplayFormat` output, spelled `T!`. For arrays and slices the
position of the `!` follows ADR-0132's rule for `?`: `[]T!` is a slice of
platform elements, `[]!T` is a platform slice. These are display forms only.

### 2. Where `T!` comes from — and where it does not

The **only** producers of `T!` are:

1. **`ClrNullability`'s three reading paths** (`ApplyReferenceNullabilityFull`,
   `SymbolFromFlagsOffset`, `NullableFlagsBuilder.MergeDeclarationNullability`),
   for a concrete reference position whose nullability byte is *oblivious*.
2. **A declaration in an oblivious G# compilation scope** (§9), which is how
   cs2gs renders an oblivious C# declaration.

ADR-0136's table is preserved in shape; exactly one cell's answer changes.
`IsFlagNonNull(byte)` — the single predicate ADR-0136 introduced precisely so the
three paths could not drift — is replaced by a single three-state classifier:

| `flags` shape | Meaning | Position `i` reads as |
| --- | --- | --- |
| **empty** (no `[Nullable]`, no `[NullableContext]` anywhere) | oblivious | **`T!`** (was `T?`) |
| **length 1**, `flags[0] == 0` | oblivious context | **`T!`** (was `T?`) |
| **length 1**, `flags[0] == 1` | annotated non-null | `T` |
| **length 1**, `flags[0] == 2` | annotated nullable | `T?` |
| **length > 1**, `flags[i] == 0` | oblivious position | **`T!`** (was `T?`) |
| **length > 1**, `flags[i] == 1` | annotated non-null | `T` |
| **length > 1**, `flags[i] == 2` | annotated nullable | `T?` |

```csharp
internal enum NullabilityState { Oblivious, NotAnnotated, Annotated }
```

`ClrNullability` returns `NullabilityState` where it returned `bool`, and the
three paths defer to one classifier exactly as ADR-0136 requires. ADR-0136's
reasoning for the single predicate holds verbatim and gains a third value.

**`ExpandNullableFlags`'s absent-position fill changes with it.** ADR-0136 fills
absent positions with `2` and says explicitly that the fill *is* the rule; under
this ADR the rule says `T!`, so the fill becomes `0`. The `absentFill` overload
exists solely to recover the literal "declared nothing" reading that the `2`-fill
destroyed — with a `0` fill the expanded array already distinguishes "declared
`T?`" from "declared nothing", so that overload and its single type-parameter-arm
caller may collapse. An implementer meets this on day one.

**Annotated BCL members are entirely unaffected.** Modern .NET assemblies carry
`[NullableContext(1)]`, so their reference members stay non-null `T`, and a
genuinely annotated nullable member stays `T?` and still requires narrowing.
`System.Object.ToString()` still returns `string?` and still must be coalesced or
bound. This pivot does not un-annotate the BCL; it changes only the answer for
positions that say nothing.

**Open type parameters keep ADR-0136's exclusion, unchanged.** An open
type-parameter position is not a concrete reference position: its nullability
arrives with the type *argument*, and an unconstrained `K` may be substituted
with a value type, where a wrapper silently changes the contract. An open slot
still widens only for an explicit `[Nullable(2)]`. This is a pre-existing,
principled exclusion stated as a rule about what a reference position *is* — not
a carve-out predicate over receiver shapes, and not one this ADR adds to.

**Value types are unaffected**, for the same reason as in ADR-0136: a value-type
position contributes no byte. There is no `int32!`. `Nullable<T>` lowering is
untouched.

### 3. Assignability and conversions

Let `T` be a reference type. Every conversion below is **implicit and
operator-free**. The governing rule is one line, and the table is its expansion:

> **A check is inserted exactly when a platform value flows into a destination
> whose declared type is a non-null reference type** — whether that destination
> is `T` itself or any supertype of it.

| From | To | Conversion | Runtime effect |
| --- | --- | --- | --- |
| `T!` | `T` | implicit | **nil check inserted** (§4) |
| `T!` | `object` / base class / interface (non-null) | implicit | **nil check inserted** — a non-null destination is a non-null destination |
| `T!` | `object?` / base / interface, nilable | implicit, identity | none |
| `T!` | `T?` | implicit, identity | none |
| `T` | `T!` | implicit, identity | none |
| `T?` | `T!` | implicit, identity | none |
| `T!` | `U` (unrelated) | whatever `T → U` is | as for `T` |
| `nil` | `T!` | implicit | none — an ordinary null store |

The upcast row is not a formality. An earlier draft had it as "as for `T`, no
check", which contradicted this section's own rule and opened a real hole:
`object o = obliviousCall()` would store a nil into a slot the program may read
back as non-null indefinitely, with **no `T! → T` boundary ever having fired**.
An upcast to `object`, a base class, or an interface *is* a conversion to a
non-null reference destination, so it checks. Stating the rule in terms of *the
destination's nullability* rather than the literal type `T` closes the family
rather than this one instance.

The last row is small and load-bearing. `nil` to a non-nullable `T` is a binder
error today, and ADR-0155 A9 records that `!!` cannot bridge it — *"`!!` forgives
a nullable value, and a literal `nil` has nothing to forgive."* Without this row,
cs2gs could not translate `return null;` from an oblivious `string`-returning C#
method, or `string s = null;` from an oblivious field initializer, and §9's whole
oblivious-scope mechanism would be unusable. An oblivious position admits nil by
construction, so assigning `nil` to it is not a forgiveness at all.

`T? → T!` is the conversion that looks alarming and is in fact the point: an
oblivious parameter genuinely admits nil — that is what oblivious *means* — so
passing a `T?` to it is exactly correct, and requiring `!!` there is the
ceremony that produced the 12,100-assertion ceiling. This single row removes the
majority of cs2gs's argument-position assertions.

**Type unification** (ternary branches, `??` results, inferred array elements,
generic inference): the least upper bound of `T!` and `T` is `T!`; of `T!` and
`T?` is `T?`; of `T!` and `T!` is `T!`. The governing principle is that **an
explicit statement always beats the absence of one** — so unifying with an
explicit `T?` yields `T?`, while unifying with a `T` (whose non-nullness is
asserted only for *that* branch, and says nothing about the platform branch)
must stay `T!` rather than silently promoting an unknown to a guarantee. Note
this is deliberately *not* symmetric absorption: `T?` wins, `T` does not.

**Type inference for an unannotated binding**: `let s = obliviousCall()` gives
`s` type `string!`. Platform-ness propagates through inference exactly as
nullability does. This is what makes chains work with no special case (§5) and
keeps the check count low.

#### Type arguments: platform-ness does **not** make constructed types mutually assignable

An earlier draft said `Box[string!]`, `Box[string]` and `Box[string?]` are
*mutually assignable*, on the reasoning that all three erase to one CLR type so
"nothing is observable at runtime." **That rule is unsound, and the erasure
argument is precisely backwards** — erasure is what makes the two views aliases
of the same object, which is what makes the hole reachable:

```gs
var b     Box[string]  = Box[string]{ Value: "x" }
var alias Box[string?] = b      // permitted by mutual assignability, no check
alias.Value = nil               // legal: Value is string? in this view
b.Value                         // declared string — reads nil, no check anywhere
```

No `T! → T` conversion is ever crossed, so §4's boundary never fires. The carrier
does not need to be exotic: any user generic with a settable property qualifies,
as do G#'s magic collections (ADR-0159). This is array covariance's bug with
nullability in place of element type, through a **mutable, invariant** container.
Note the example does not even mention a platform type — the draft's rule was
strong enough to license `Box[string] ↔ Box[string?]` on its own, which plain
invariance has always and correctly rejected.

**The rule, corrected.** Platform-ness at the top level is flexible; platform-ness
*inside a type argument* is not a licence to convert the constructed type.

1. `Box[string!]`, `Box[string]` and `Box[string?]` are **three distinct
   constructed types**.
2. **Exactly one implicit conversion exists**: `C[T!] → C[T?]` (recursively, for
   nested arguments). No check. It is sound because every read through the
   destination view has type `T?` and must be narrowed before non-null use, so no
   view of the object can produce an unchecked non-null read.
3. There is **no** `C[T!] → C[T]`, no `C[T] → C[T!]`, and no `C[T?] → C[T!]`.
   The first is the unsound direction directly (non-null reads of a container
   that may hold nil). The second and third are unsound in the write direction:
   both would let `nil → T!` (§3's last row) deposit a nil into a container
   another holder reads as non-null.
4. `C[T] ↔ C[T?]` remains unconvertible by ordinary invariance, **unchanged by
   this ADR**.
5. **Member access through a `C[T!]` receiver yields `T!`-typed elements.**
   `pb.Value` on a `Box[string!]` has type `string!` and is checked at its own
   coercion point; `pb.Value = nil` is legal. This is §4's top-level rule applied
   one level down, it needs no conversion at all, and it is where essentially all
   of the ergonomic benefit actually comes from.

Rule 5 is what makes rule 3 affordable. The apparent cost — you cannot pass a
`List[string!]` to `func f(xs List[string])` — **is not a new cost**: ADR-0136
already renders that oblivious container as `List[string?]`, and already rejects
passing it to `List[string]` by the same invariance. The platform model matches
the status quo for the container and strictly improves on it for the top-level
value. Meanwhile §3's governing principle gives the same answer it gives
everywhere else: the callee's explicit `List[string]` beats the caller's absence
of information, so the caller does the work.

**This is a place where G# is deliberately stricter than Kotlin.** Kotlin's
flexible types are genuinely unsound here and accepted as the price of Java
interop. G# should not copy that, for two reasons it does not share: `T?` is
load-bearing across the whole language rather than an interop affordance, and
ADR-0159's magic collections make "a mutable invariant container whose element
nullability is a lie" a routine shape rather than an exotic one. Adopting the
category does not oblige adopting its known holes.

**Overload resolution.** A `T!` argument is applicable to a `T` parameter and to
a `T?` parameter. When both are applicable the `T` parameter wins, by the same
specificity rule that already prefers a more specific parameter type. This is
stated explicitly because it is the tie-break that keeps a platform argument
behaving like the non-null value it usually is.

### 4. The runtime assertion: one rule, at coercion points only

> **The rule.** A nil check is inserted wherever a platform value is converted
> to a destination whose declared type is a **non-null reference type**, and
> nowhere else.

That is the complete specification. Everything below is consequence, not an
additional list of sites. Note the rule is stated over the *destination's
nullability*, not over the literal type `T`: an upcast to `object`, a base class
or an interface is such a destination and checks accordingly (§3). Writing it as
"`T! → T`" — as an earlier draft did — reads as though only the exact type
counted, and left upcasts as an unchecked hole.

Concretely, such a conversion occurs — and a check is therefore inserted —
when a platform value is:

- assigned or bound into a slot whose **declared** type is a non-null reference
  type: a `let`/`var` with an explicit type, a field, a property, an array or
  slice element store, an `out`/`ref` target;
- passed as an **argument** to a parameter whose declared type is non-null. **An
  extension method's receiver is an argument** — the rule commit `81a9400d`
  already articulated for G# — so an extension receiver is checked here;
- **returned** from a function whose declared return type is non-null;
- the operand of `!!` (which *is* the explicit spelling of this conversion);
- used where the language requires a non-null reference: a `throw` operand, a
  `lock`/`sync` subject, a `foreach`/`range` source.

And a check is **not** inserted when a platform value is:

- assigned into a `T?` or `T!` slot, or passed to a `T?` or `T!` parameter —
  no conversion to non-null occurs, so interop-to-interop flow costs nothing;
- bound by `let x = …` with no explicit type — `x` is `T!`, no conversion;
- compared to `nil`, tested by `if let`, or traversed by `?.` (§6);
- **the scrutinee of a type pattern.** A type pattern against a nil scrutinee
  **does not match**; it does not throw. `case s string:` on a nil `string!`
  falls through to the next arm, exactly as C#'s `is T` and Kotlin's `is T` do
  for a null subject, and exactly as G# already does for a `T?` scrutinee. A
  pattern test is a *question about* the value, not a use of it as non-null, so
  it is not a `T! → T` conversion at all. The binding a matching pattern
  introduces is non-null because the match succeeded, not because anything was
  checked.
- **the receiver of an instance member access, call, or indexer** — but this one
  is *conditional*, and the condition is not currently met. See below.

#### The receiver exemption is conditional, and its condition does not hold today

An earlier draft of this ADR claimed the receiver exemption was *provable from
the emit shape*: gsc emits `callvirt`/`ldfld` for a reference receiver, the CLR
checks it at the same IL offset in the same frame, so a G# check would be pure
duplication. **That claim is false as stated, and an adversarial review falsified
it by enumerating the emitter's opcode-selection sites.** The correction is
recorded here rather than quietly dropped, because the original claim is exactly
the kind of "stated once, in one place, falsifiable" reasoning this ADR asks
readers to trust.

What the emitter actually tests is not "is this a reference type":

```csharp
// MethodBodyEmitter.MemberAccess.cs:1002, 1007 (main)
var receiverIsClass = access.Receiver.Type is StructSymbol rs && rs.IsClass;
var receiverIsInterface = access.Receiver.Type is InterfaceSymbol;
…
this.il.OpCode(receiverIsClass || receiverIsInterface ? ILOpCode.Callvirt : ILOpCode.Call);
```

Both are literal symbol-kind tests. A `NullableTypeSymbol`- or
`PlatformTypeSymbol`-**wrapped** receiver type fails both, and so do `string`,
`Array`, and any imported type that is not a `StructSymbol{IsClass:true}`. The
families that perform **no** receiver nil check today, each verified against the
emitter:

| Path | Site | Opcode | Consequence for a nil `T!` receiver |
| --- | --- | --- | --- |
| Wrapper-typed property receiver | `MethodBodyEmitter.MemberAccess.cs:1002–1010` | `call` | Nil reaches the accessor body. Also silently drops virtual dispatch — a real, reachable, pre-existing bug independent of this ADR, filed as **#4312**. |
| `string` / `Array` receivers | same test, same site | `call` | Nil reaches the method. |
| Non-virtual user **event** accessors | `MethodBodyEmitter.Closures.cs:677–709`, `isVirtual ? Callvirt : Call` | `call` | Nil reaches `add`/`remove`. |
| Non-virtual / sealed **method-group capture** | `MethodBodyEmitter.Closures.cs:510–543` (the non-virtual arm of the `ldvirtftn`/`ldftn` choice) and `:1034–1063` | **`ldftn`** | **The worst case, and the one that decides the matter.** `ldftn` does not dereference the receiver at all: the nil is stored into the delegate's `Target` slot and travels arbitrarily far. There is no failure at the capture site, and the eventual failure — if any — happens at invoke time in an unrelated frame, or never, if the captured method never touches `this`. The attributable boundary this ADR exists to provide is not delayed here; it is destroyed. |

Even a generous reading of the exemption — *"the CLR fails fast at the receiver
anyway, so an inserted check only improves the message"* — is simply false for
method-group capture. And §9 makes every row above reachable for **G#-declared**
members, not merely imported ones: a member of an `@Oblivious` declaration is
platform-typed and can be captured exactly like an imported one.

So the honest rule is:

> **Instance-member receivers get the check, the same as every other `T! → T`
> coercion.** The CLR's own check on a `callvirt`/`ldfld` receiver makes the
> inserted check *redundant where it fires*, which is a reason to **elide** it
> as an optimization (§4's elision paragraph), not a reason to specify an
> exemption.

An exemption may be re-derived later, and should be, because the redundant checks
are pure cost. Its prerequisite is that the emitter's opcode selection be unified
onto a single "is this receiver a reference at runtime" predicate that sees
through type wrappers — that is #4312/#4313's work, not this ADR's. Until then
the exemption is a performance optimization gated on a correctness fix, and
writing it into the specification would make the design's safety depend on an
emit property that four known code paths violate.

Two receiver positions would need the check even under a future exemption, and
are already covered by the argument rule above: an **extension** receiver (a
static call — argument 0, where the CLR checks nothing) and a **constrained**
call through a type parameter. The constrained case is wrong in the *safe*
direction — a check there is redundant rather than missing — which is acceptable
and worth noting only so a reader does not mistake it for a hole.

#### What the check emits

The existing `!!` lowering, with a message. At the check point:

```
dup
brtrue.s   nonNull
pop
ldstr      "<expr> was nil (nullability-oblivious value from <origin>) at <file>:<line>"
newobj     instance void [System.Runtime]System.NullReferenceException::.ctor(string)
throw
nonNull:
```

`NullReferenceException` is deliberately kept as the exception type, not a new
one: existing `catch` clauses in both G# and interop code keep behaving as they
do, and the improvement is the *message*, which names the expression and the
boundary. No runtime assembly dependency is introduced — the cost is eight bytes
of IL plus one string per check. (A `GSharp.Runtime` helper call, Kotlin's
`Intrinsics.checkNotNull` shape, is smaller per site and is worth measuring
later; it is deferred, not rejected.)

**The check is elided** where the value is already statically non-null — after
ADR-0069 narrowing, after an `if let`, or for a second coercion of the same
`AccessPath` with no intervening write in the same basic block. This is an
optimization, not a semantic rule, and it reuses the redundancy knowledge GS0536
already has.

A compiler switch `--platform-nil-checks=off` suppresses insertion for
measurement and for builds that accept the trade. It is **on** by default.
Turning it off is **strictly weaker than either the old or the new model**, and
should be described that way: today many of those sites are compile *errors*, and
with checks off they are neither an error nor a check — the nil simply travels
until something else notices. It is a measurement and escape-hatch switch, not a
supported mode.

### 5. Member access on a platform receiver: the lookup invariant

The invariant has **two clauses**, and both are load-bearing. An earlier draft
stated only the first, which constrains *which member is selected* but says
nothing about *what type the expression has afterwards*.

> **5a — Selection.** Member lookup, overload resolution and extension resolution
> on a receiver of type `T!` run against `T`, and select **exactly** the member
> they would select for a receiver of type `T`.
>
> **5b — Result type.** The resulting expression's type is **exactly** the type
> it would have for a receiver of type `T`, with the callee's own declared
> nullability applied. Unwrapping `T!` for lookup must not degrade a symbolic or
> generic-substituted projection to an erased one.

**5a** is the mechanism that replaces the carve-out system and makes failure mode
5 unrepresentable: a receiver's platform-ness cannot influence which member is
chosen, because the lookup never sees it. An instance member wins over an
extension by the ordinary priority rule; `List[int32]!.Reverse()` binds
`List<T>.Reverse` because `List[int32].Reverse()` does; `string!.Trim()` binds
`string.Trim` because `string.Trim()` does.

**5b** is the clause an implementer will get wrong by default, and it has a
named hazard. `GetImportedTypeSymbol` is a *closed switch* over receiver type
symbols with no `PlatformTypeSymbol` arm; reached with one, it falls through to
the erased answer, which would silently drop symbolic projection at its **11 call
sites** — turning `Queue[Entry]!.Dequeue()` from `Entry` into an erased CLR
mapping. The fix is to unwrap `T!` to `T` *before* type resolution runs, on the
same path that resolution already uses, rather than teaching each consumer about
the wrapper. (This is adjacent to, but distinct from, pre-existing bug #4314: this
one is a gap this ADR introduces if the unwrap is placed too late.)

The result type then carries the callee's *own* declared nullability: an
oblivious member's result is `T!`, an annotated nullable member's result is `T?`,
an annotated non-null member's result is `T`. Chains therefore compose with no
chain-tracking predicate at all — `s.ToUpper().Trim()` is `string! → string!`,
and the intermediate needs no syntax, no `BoundNode` kind check, and no
threading of `receiverSyntax`. The receiver itself is passed through unchanged
and checked per §4.

### 6. Narrowing, nil comparison, and the existing operators

`T!` participates in every existing null-handling construct, and none of them
change:

- **`x == nil` / `x != nil` is legal** on a `T!`. GS0129 (nil comparison against
  a non-null reference type) does not fire — a platform value may be nil, and
  being able to say so is the whole difference between `T!` and `T`.
- **ADR-0069 smart-cast narrowing** applies: inside `if x != nil { … }`, `x` has
  type `T`, and §4's check is elided there. Narrowing a `T!` is a *convenience*,
  not an obligation — this is the load-bearing difference from today, where it is
  the only way to compile.
- **`if let` / `guard let` / `while let`** accept a `T!` initializer and bind `T`.
  GS0296 ("initializer must be of nullable type") must accept `T!`.
- **`?.` and `?[`** accept a `T!` receiver and yield `U?` as usual. GS0300 (null
  conditional on a non-nullable receiver) does **not** fire for `T!`.
- **`??` and `??=`** accept a `T!` left operand. GS0298 does not fire.
- **`!!`** on a `T!` yields `T` and emits the check. It is legal, it is not
  redundant, and **GS0536 must not fire on it** — it is the explicit spelling of
  a conversion the compiler would otherwise perform implicitly at the same point.
  This is what keeps every existing `!!` in the migrated corpus compiling and
  meaning precisely what it means today.
- **GS0523** (ADR-0159, `== nil` against a bare magic collection) does not fire
  for a platform-typed collection: `map[K, V]!` can genuinely be nil.

### 7. Diagnostics

| Diagnostic | Fate |
| --- | --- |
| **GS0159** "receiver may be nil" | **Unchanged in definition, narrowed in reach.** It fires exactly when the receiver's type is a `NullableTypeSymbol` — a source-declared `T?` field, local, parameter or return, an annotated-nullable BCL member, a tuple element, an `as` result (ADR-0160). It can no longer fire for an oblivious CLR receiver, because such a receiver is not a `NullableTypeSymbol`. The bug #4287 reported (`this.name.ToUpper()` on a G#-declared `string?`) still reports it. |
| **GS0129** nil comparison on non-null | Unchanged for `T`; does not apply to `T!`. |
| **GS0536** redundant `!!` | Unchanged, plus one rule: a `T!` operand is never redundant. |
| **GS0296 / GS0298 / GS0300 / GS0503 / GS0523** | Each gains `T!` on the "admits nil" side of its test. |
| **GS0592** (new, **warning, opt-in**) | *"A nullability-oblivious value is used where a non-null `T` is required; a runtime nil check is inserted."* Reported at each `T! → T` coercion. **Off by default**, enabled by `--gsdiag:GS0592=warning` or `.editorconfig`. This is the audit tool that replaces GS0159's lost signal for anyone who wants it, and it is a *report on a check that exists*, never a build break. |

There is deliberately **no new error**. The design's claim is that the compiler
does not know, and a compiler that does not know should not be issuing errors.

### 8. Emit and metadata round-trip

ADR-0136 §3 established the round-trip linchpin: because "absent attribute →
nullable" was the rule, the emitter had to stamp *complete* metadata or a
gsc-emitted non-null member would re-import as nullable. That reasoning survives
with one addition — the emitter now has a third thing to say.

- A declaration in a **nullability-enabled** scope emits exactly as today:
  type-level `[NullableContext(1)]`, per-field/property/parameter/return
  `[Nullable(flags)]` with `2` for nullable positions. Re-import yields `T` / `T?`
  unchanged, and ADR-0136's `Issue1354NullabilityRoundTripEmitTests` guarantee
  holds byte-for-byte.
- A declaration in an **oblivious** scope (§9) emits either **nothing** — which
  is `csc`'s own shape for `#nullable disable` code — or an explicit
  `[NullableContext(0)]` with byte `0` for oblivious positions in any per-member
  array. Both read back as `T!` under §2's table (the *empty* row and the
  *byte `0`* rows give the same answer), so either is correct and the choice is
  an emit-size question. Emitting nothing has the advantage that the round-trip
  is validated against `csc`'s output for free.

The round-trip guarantee therefore becomes three-valued and total: non-null stays
non-null, nullable stays nullable, **oblivious stays oblivious**. Under ADR-0136
the third case was not expressible — an oblivious G# declaration had to be
emitted as something it was not.

### 9. Declaring obliviousness in G# source

`T!` is unspellable, so a G# *source* declaration cannot write a platform type
directly. It does not need to: obliviousness is a property of a **scope**,
exactly as it is in C#, and G# adopts the same two-level mechanism C# uses
(`<Nullable>` plus `#nullable`), rendered in G#'s own idiom — G# has no `#`
directives; ADR-0047/ADR-0175 established the annotation as the mechanism.

1. **Compilation level.** `--nullability=enabled|oblivious`, default **enabled**.
   In an oblivious compilation, every unadorned reference position in a
   *declaration signature* means `T!`; `T?` still means `T?`. Expression-level
   typing is unchanged — this switch governs declarations only.
2. **Declaration level.** `@Oblivious` — an ADR-0047 annotation valid wherever an
   annotation already is (type, function, property, field, event, parameter) —
   makes that declaration's unadorned reference positions `T!` regardless of the
   compilation default. `@NullabilityEnabled` is its inverse, for a declaration
   inside an oblivious compilation.

Hand-written G# never uses either. Both exist for one consumer — cs2gs — and
both are removable per project as that project's C# source migrates, exactly as
ADR-0155's per-file `#nullable enable` directives were migration noise deleted at
the moment their project flipped.

This is the **only** new language surface this ADR introduces, and it is the
decision most worth a reviewer's attention (see Open questions).

### 10. cs2gs under the new model

cs2gs's current nullability machinery exists to answer a question G# could not
express: *"this C# position says nothing about nullability — what do I write?"*
With no way to write "nothing", it had to choose `T?`, and having chosen `T?` it
then had to satisfy gsc's proof obligation everywhere that value was used. The
whole-program `IsTainted` fixpoint and the `!!`-insertion pass are both
consequences of that one missing spelling.

Under this ADR the question has a direct answer, and it is read off Roslyn
per-position rather than inferred:

| Roslyn `NullableAnnotation` | cs2gs emits | gsc reads it as |
| --- | --- | --- |
| `Annotated` | `T?` | `T?` |
| `NotAnnotated` | `T` in an enabled scope | `T` |
| `None` (oblivious) | `T` in an oblivious scope (`--nullability=oblivious` or `@Oblivious`) | **`T!`** |

cs2gs already computes this column. `IsObliviousCompilation()` is
compilation-level only (`NullableContextOptions == Disable`, it reads no per-tree
`#nullable` directives), and what actually keeps a `#nullable enable` region
inside an oblivious project out of the taint branch is the per-position
`declared.NullableAnnotation == None` guard at
`Nullability.cs:1315`. **That guard is the new rule**, promoted from a
precondition on a guess to the whole answer. Nothing new has to be discovered;
what changes is that its answer now has somewhere to go.

#### The two buckets — and why only one of them goes away

cs2gs's nullability surface is about 11,000 lines across six files, and it splits
cleanly in two. Keeping the split honest is the difference between a credible
impact claim and an inflated one.

- **Bucket (a) — oblivious promotion.** Everything gated on
  `IsObliviousCompilation()`, `NullableAnnotation.None`,
  `ObliviousNullabilityAnalyzer.IsTainted`, or the imported-oblivious mirror
  rules. This exists *only* because G# cannot spell "nothing was stated", and it
  goes away.
- **Bucket (b) — narrowing compensation.** Everything that bridges a **declared**
  `T?` through a guard: gsc's Kotlin-style smart casts never narrow a
  property/field-access chain (`ReceiverIsNullableReferenceFieldOrProperty`'s own
  doc comment states the invariant), and gsc does not narrow a bare member
  reference where it narrows the `this.`-qualified one (issue #4310). **None of
  that is about obliviousness, and none of it changes.**

#### Deleted (bucket a)

- **`ObliviousNullabilityAnalyzer.cs` — 5,385 lines — in full.** This is where
  the whole-program fixpoint actually lives (not in
  `CSharpToGSharpTranslator.Nullability.cs`, which only calls it). The fixpoint
  loop itself is 41 lines; the other 5,344 are the edge-collection surface —
  seeds for nine null-evidence syntax shapes, roughly forty edge collectors,
  three separate taint domains (`HashSet<ISymbol>`, a `TupleElementKey` domain
  for per-element tuple taint, and a string-keyed `params`-element domain),
  cross-project symbol remapping, and interface/override/delegate contract edge
  closure. All of it exists to guess which oblivious positions might receive a
  null somewhere in the program. Under the new model no guess is needed: the
  position's own `NullableAnnotation` is the answer, it is local, it is exact,
  and it is what the C# compiler itself used.
- **`ConditionalNotNullPostcondition.cs` — 185 lines.** It exists to emit a
  forwarding edge into that fixpoint for `[return: NotNullIfNotNull]`; with no
  fixpoint there is no edge.
- **The taint rule and its dependents in
  `CSharpToGSharpTranslator.Nullability.cs`** — `ShouldPromoteToNullableReference`'s
  rule 5 (the `NullableAnnotation.None && IsTainted` arm), the EF-entity arm, the
  pure-forwarding closure, the `Promote*` family for returns, awaits,
  `Task<T>` envelopes, tuples and array elements, the shared-document /
  positional-record plumbing that exists for cross-project taint agreement, and
  `TargetWillRemainNonNullableReference`'s imported-oblivious arm. Roughly
  **1,400 of that file's 1,790 lines**.
- **The oblivious half of the forgiveness insertion in
  `CSharpToGSharpTranslator.Expressions.cs` — roughly 1,500–1,700 lines**:
  `ReceiverIsNullableReferenceFieldOrProperty`'s two oblivious arms,
  `ReceiverValueIsPromotedNullable`, `ReceiverValueIsObliviouslyReadAnnotatedResult`,
  the tainted-arm and unguarded-forward families, and
  `IsImportedObliviousNullableMember` /
  `LocalInitializedFromImportedObliviousNullable`. Of
  `ReceiverNeedsNullForgiveness`'s **13 telemetry-keyed rules, 11 are bucket (a)**.
- **The four imported-oblivious *mirror* rules become dead by construction.**
  They exist solely to mirror gsc's own import rule
  (`ClrNullability.IsPositionNonNull`: *"only an explicit `1` means non-null;
  `2`, `0` and absent all mean nullable"*). §2 changes that rule's answer for
  byte `0`/absent, and the mirrors have nothing left to mirror.
- **A whole-repository compilation load leaves the pipeline.**
  `TranslationContext.cs` documents that `RepositoryCompilations` — every
  compilation in the repo — is loaded by `TranslateStage` *"purely for this taint
  lookup."* That is a runtime and memory cost on every migration run, not just
  lines of code.

#### Survives unchanged (bucket b)

- **`GuardedFieldLocalCapture.cs` — 485 lines.** It rewrites a guard-dominated
  field read to a captured local so gsc *can* smart-cast it, collapsing N
  assertions into one. Its own header measures the shape at **220 of 787 (28%) of
  `!!` sites in a real corpus**. A `T?` field guarded by `if (F == null) return;`
  is a narrowing problem, not an obliviousness problem.
- **`TranslateReceiverWithNullForgiveness` itself and its 13 receiver-position
  call sites**, plus the value-position siblings
  (`TranslateValueWithNullForgiveness`, `TranslateIndexArgumentWithNullForgiveness`).
  A declared-`T?` field or property chain still needs an assertion.
- **The stable-access-path machinery** (`IsGSharpFlowNarrowedFieldOrPropertyInSameCondition`,
  `IsSameStableAccessPath`, `TryDecomposeStableAccessPath`, `IsStableMemberSymbol`,
  `IsStableAutoProperty`) and the bare-vs-`this.`-qualified guard commit
  `539d8c3a` added. These mirror gsc's `AccessPath` / `SmartCastStability` and
  stay exactly as correct — and as necessary — as they are today.
- **`ShouldPromoteToNullableReference`'s declaration-only rules**: ADR-0155 A9's
  `[AllowNull]` write contract, `[InlineData(null, …)]` evidence, and the
  delegate-parameter `= null` default. Each is decided by the declaration alone,
  which is precisely why ADR-0155 A9 preferred them over consumer inference. In
  an *oblivious* scope they are moot (the position is already `T!`, which admits
  nil by construction); in an *enabled* scope they are unchanged.
- **`NullAssertionPolishPass` — 549 lines — shrinks but does not vanish.** Bucket
  (b) still emits speculative assertions and still relies on the pass to strip
  the unnecessary ones (both `a967928a` and `539d8c3a` say so explicitly). Its
  size under `T!` is a function of how much bucket-(b) speculation remains, not
  of the nullability model. Retire it only if measurement supports it.

#### The headline, stated conservatively

**Total nullability surface in cs2gs is roughly 10,300–10,700 lines. The split
between deletable and surviving is an estimate that has already moved once under
review, and should be measured rather than quoted.**

The current best estimate is **~7,000–7,300 deletable** against **~3,300–3,600
surviving**. An earlier draft of this ADR said 8,300–8,600 / ~1,900, and was
wrong on the surviving side by roughly 2×, for one instructive reason: it
conflated *"lives in `ObliviousNullabilityAnalyzer.cs`"* with *"is oblivious
machinery."* That file also hosts **~1,150–1,250 lines that serve nullable-enabled
C#** — the `<auto-generated/>` evidence family, `HasAllowNullWriteContract`,
`HasNullDataRowArgument` — which this ADR's own bucket-(b) list separately claims
survives. Both claims cannot hold; the file-level attribution was the wrong one.
The same draft counted 11 of `ReceiverNeedsNullForgiveness`'s 13 rules as bucket
(a); the correct count is **9**, since rules 3 and 4 are the
`GuardedFieldLocalCapture` family and are narrowing compensation.

The lesson generalises: **an impact estimate derived by reading gates and file
boundaries is not a measurement, and this one has now been wrong once in the
direction that flatters the proposal.** The claim is checkable before any code is
written — every `ReceiverNeedsNullForgiveness` rule already records a distinct
`NullForgivenessTelemetry` key, so one corpus run gives the real per-rule `!!`
counts and divides them between the buckets. **Run that before quoting any figure
in a planning document, and treat the numbers above as provisional until then.**

The self-migration `nullAssertionCeiling` becomes a shrinking metric rather than
a corpus-size-tracking one. This is the headline verification signal: the
migration is correct under the new model only if the corpus stays at its
`greenFloor` while that number falls sharply. Ratchet it down, per ADR-0154's
"improve a metric, then tighten it in the same PR" rule.

## The six case studies, walked through

Each is shown resolving from the design's two invariants — *the origin of
nullability is in the type* (§1–§2) and *lookup on a `T!` receiver runs against
`T`* (§5) — with no predicate consulted.

**1. Read/call drift (`Environment.Version.Major` vs `.ToString()`).**
`Environment.Version` is oblivious, so its type is `Version!`. §5 says member
lookup on a `Version!` receiver runs against `Version` — for a read and for a
call identically, because §5 makes no distinction between access kinds. Both
compile. There is no `CanBindClrInstanceMember`, so there are no two copies of it
to drift. The receiver is emitted as-is and the `callvirt`/`ldfld` checks it.

**2. The generic-instance-call branch that forgot the helper
(`x.Up[Node]()`).** Two halves, and honesty requires separating them. On gsc's
side the failure is gone outright: all three of `x.Parent`, `x.Plain()` and
`x.Up[Node]()` bind by §5 against `SyntaxNode` and cannot disagree, because §5
consults nothing that could differ between them. The eight-shape witness table in
commit `a967928a` collapses to "all eight bare, all eight correct." On the cs2gs
side the claim is narrower: `TranslateReceiverWithNullForgiveness` **survives**
for declared-`T?` field and property chains (§10, bucket b), so a future branch
could still forget to call it. What changes is the population it serves — the
specific receiver that broke here was *an oblivious parameter the taint fixpoint
had promoted*, and that entire population is `T!` under the new model and needs
no assertion at all. The residual exposure is confined to declared-`T?` members,
where a missing assertion is a compile error the self-migration gate already
catches, never a silent one.

**3. The chained call the message-formatter silently disabled
(`s.ToUpper().Trim()`).** `s.ToUpper()` has result type `string!` — the callee's
own declared (oblivious) nullability, per §5. `.Trim()` then binds against
`string` by §5 again. **No diagnostic is computed at all**, so no diagnostic's
formatting requirements can gate anything: there is no `receiverSyntax`,
`receiverStart`, `receiverName` or `(receiverSyntax ?? receiver.Syntax)`
expression anywhere on this path. The structural defect — *a message-formatting
detail deciding whether a safety check runs* — is removed by removing the check
whose message it was. `s.ToUpper().Length`, `s.ToUpper()[0]`,
`sb.Append("a").Append("b")` and `(s.ToUpper()).Trim()` are the same case and all
four behave identically, which parenthesisation-sensitivity previously proved
they did not.

**4. `X != nil && X.Contains(i)` vs `this.X != nil && this.X.Contains(i)`.** If
`X` is an oblivious CLR member, its type is `T!` and **neither form needs
narrowing** — both compile, both emit the same IL, and the asymmetry is
*irrelevant* rather than fixed. If `X` is a G#-declared `T?`, issue #4310 is
unchanged: the qualified form narrows, the bare form does not, and this ADR does
not close that gap. Stating both halves matters — the design removes the
asymmetry's *reach into CLR interop*, which is where it was doing damage, and
leaves the underlying `AccessPath`-keying gap exactly as #4310 describes it, for
#4310 to fix.

**5. `xs.Reverse()` on `List[int32]!` — the silent miscompile.** §5 is the whole
answer: lookup runs against `List[int32]`, finds the instance member
`List<T>.Reverse` on the type's own surface, and binds it — because that is what
lookup on `List[int32]` does. `Enumerable.Reverse` is an extension and loses to
an own-surface instance member by the ordinary priority rule, on a platform
receiver exactly as on a plain one. **The receiver's nullability is not an input
to member lookup, so it cannot select a different member.** The same argument
gives `string!.Trim()` the type `string` via `string.Trim`, never
`ReadOnlySpan<char>` via `MemoryExtensions`. A platform receiver never reaches
the probe at all, so there is nothing for the probe to get wrong. **The gate
itself is not deleted, and is not widened**: a G#-declared `List[int32]?` still
reaches the probe and still needs `ExtensionDeclaresNilableReceiver` — testing
`is NullableTypeSymbol`, *not* `or PlatformTypeSymbol` — to reject
`Enumerable.Reverse`. (This presumes PR #4308's gate lands; on `main` today it
does not exist, and the miscompile is reachable for a G#-declared `T?` receiver
independently of this ADR.)
What this design removes is the entire *population* of receivers whose
nullability came from metadata — which is where the miscompile was found and
where it could never have been reasoned about, because nobody stated the fact the
reasoning turned on.

**6. `IEnumerable[T]!.Min()` / `List[int32]!.Count()` — right method, unguarded
receiver.** §5 binds `Enumerable.Min` / `Enumerable.Count`, the correct and only
candidate (`List<T>.Count` is a property, so `Count()` with parens can only be
the extension). These are *static* calls, so the CLR checks nothing; §4's
argument rule therefore applies — the extension's declared `this` parameter is
non-null `IEnumerable[T]`, so the `T! → T` coercion inserts a check, and a nil
source throws a message naming the expression instead of an `ArgumentNullException`
from inside `Enumerable`. **No diagnostic, no source edit, no `!!` added to
`Issue4065`, `Issue2494` or their mirrors.** The scope question failure mode 6
posed — is a latent throw in scope for a narrow fix? — dissolves: both classes
are handled by the same rule, one by lookup and one by coercion, and neither
requires a decision about how far the change should reach.

## Implementation impact

### Deleted

**Binder — against `main`'s baseline** (the only baseline that is certain):

| Location | What goes |
| --- | --- |
| `ExpressionBinder.Access.MemberLookup.cs:941–946` | The `\|\| receiver is BoundClrPropertyAccessExpression` disjunct of `CanBindClrInstanceMember`. It reverts to the plain non-nullable test, because a `PlatformTypeSymbol` receiver is not a `NullableTypeSymbol` and never enters the branch the disjunct exists to rescue. **That is the entire binder deletion on main: one disjunct.** |

> **Implementation note (step 4, PR #4353): this row was not performed.** The
> premise — that the disjunct's whole population is oblivious members imported
> as `T?` — missed a second population it has always carried: *annotated*-
> nullable imported members (`[Nullable(2)]`, e.g. `Exception.InnerException`,
> or Roslyn API members declared `T?`) used as an intermediate link in a member
> chain, read or write (`e.InnerException.Message`,
> `a.MaybeNumbers.Capacity = 4`). Deleting it broke that code — 20
> `Cs2Gs.Tests` failures on real Roslyn-analyzer source and the Oahu migration
> gate — and this ADR leaves annotated members out of scope (*Explicitly out of
> scope*). The disjunct is therefore **kept**. Under the default mode it cannot
> re-admit an oblivious receiver: that receiver is `T!`, the §4 coercion checks
> and unwraps it before lookup, and it satisfies the first disjunct as plain
> `T`. What the second disjunct admits is exactly the annotated-nullable chain
> it always admitted, with the same (unchecked) dereference as before this ADR.
> Step 4's binder change is therefore documentation and tests pinning that
> separation, not a deletion.

**Binder — additionally, *if* PR #4308 lands first** (it is closed and unmerged;
none of these symbols exists on `main`):

| Location | What goes |
| --- | --- |
| `ExpressionBinder.Access.MemberLookup.cs` | `IsImportedClrChainReceiver` in full — the four-arm successor to main's one-arm disjunct. |
| `ExpressionBinder.Calls.Invocation.cs` | **One condition**: the `&& !CanBindClrInstanceMember(receiver)` conjunct guarding the `nullableInnerVt is { IsValueType: false }` block. The block **body stays** — see *Kept*. |

**cs2gs** (all on `main`):

| Location | What goes |
| --- | --- |
| `ObliviousNullabilityAnalyzer.cs` | The `IsTainted` fixpoint, its three taint domains, ~40 edge collectors, and cross-project remapping — **most, but not all, of the file's 5,385 lines**. See the bucket note below: ~1,150–1,250 lines in this file serve nullable-*enabled* C# and survive. |
| `ConditionalNotNullPostcondition.cs` | The whole file — 185 lines; it exists only to feed that fixpoint. |
| `…Translator.Nullability.cs` | `ShouldPromoteToNullableReference`'s taint/EF/pure-forwarding arms, the `Promote*` family, the shared-document/positional-record taint plumbing, and `TargetWillRemainNonNullableReference`'s imported-oblivious arm. |
| `…Translator.Expressions.cs` | **9 of `ReceiverNeedsNullForgiveness`'s 13 rules**, both oblivious arms of `ReceiverIsNullableReferenceFieldOrProperty`, `ReceiverValueIsPromotedNullable`, `ReceiverValueIsObliviouslyReadAnnotatedResult`, and the imported-oblivious mirror predicates. |
| cs2gs pipeline | The whole-repository compilation load `TranslationContext` documents as existing *"purely for this taint lookup."* |

### Simplified

- `ClrNullability`: `IsFlagNonNull` → a three-state `NullabilityState`
  classifier; the three reading paths keep their shape and gain one case.
- **PR #4308's block becomes unconditional.** With its `CanBindClrInstanceMember`
  conjunct removed, it runs for *every* reference-typed `NullableTypeSymbol`
  receiver — which, under §2, is now always a source-declared or
  annotated-nullable `T?`. That is a simplification of the condition, not of the
  body.
- `ExtensionDeclaresNilableReceiver` / `ImportedReceiverParameterAdmitsNil`
  (branch-only): **unchanged — the test stays `is NullableTypeSymbol`.** An
  earlier draft proposed widening it to
  `is NullableTypeSymbol or PlatformTypeSymbol`, which was wrong and re-admitted
  failure mode 5: a **G#-declared** `List[int32]?` receiver against an
  **oblivious-assembly** extension would pass the widened gate and bind the wrong
  method again — commit `359538cd`'s exact shape. It also contradicted §3's
  governing principle, *an explicit statement always beats the absence of one*.
  An oblivious author declared *nothing* about nil, which is not a declaration
  that nil is welcome. Commit `359538cd`'s own rationale for admitting oblivious
  extensions was that "unannotated metadata surfaces as `T?`" — under §2 it no
  longer does, so that rationale evaporates rather than transferring.
- `NullAssertionPolishPass` (549 lines): same code, far less input; retire only if
  measurement supports it, since bucket-(b) speculation still needs it.
- `DiagnosticBag.ReportUnableToFindFunction`'s nullable-`receiverName` overload:
  kept (a chained *source*-`T?` receiver still has no syntax to quote), but it is
  now the only thing the syntax-optionality serves.

### Kept — and this is the honest scope of the win

The machinery that serves a **G#-declared `T?`** receiver is correct and stays,
because that receiver's nullability *is* known and proving it is the right thing
to do. This is worth stating precisely, because a careless reading of "delete the
#4287 machinery" would reintroduce #4287:

- **The whole body of PR #4308's block stays.** It is the *only* thing that makes
  `this.name.ToUpper()` with `name string?` report GS0159. Commit `b7856060`'s
  root cause is that `NullableTypeSymbol.ClrType == underlying.ClrType` is
  non-null for a `string?`, so the older fallback (which runs only when
  `effectiveReceiverType.ClrType` is null) never fires for it. Remove the body and
  the headline bug returns for exactly the receiver this ADR promises still
  errors. Kept: both extension probes, both `Diagnostics.TruncateTo` mark/rollback
  pairs, the `ExtensionDeclaresNilableReceiver` gate,
  `ImportedReceiverParameterAdmitsNil`, the receiver-name-optional report, and the
  `TryBindInheritedClrInstanceCall` own-surface arm and
  `underlyingType.ClrType is { IsInterface: true }` arm PR #4308 added to
  `IsApplicableNullableUnderlyingCall`.
- **The declared-nilable extension gate stays and is still needed.** A
  **G#-declared** `xs List[int32]?` still enters this block and still resolves
  extensions; without the gate it would still bind `Enumerable.Reverse` over
  `List<T>.Reverse`. Failure mode 5 is *unrepresentable for a platform receiver*
  because §5 never consults nullability there — it is not un-fixed for a
  source-declared `T?` receiver, where the gate remains the fix.
- The extension probe's *purpose* — `func (s string?) OrEmpty() string` must stay
  callable on a `string?` without narrowing — is unchanged.
- All of ADR-0069 / ADR-0071 / ADR-0073 narrowing, unchanged.
- On the cs2gs side, the whole of bucket (b) — ~3,300–3,600 lines (§10),
  including the ~1,150–1,250 lines *inside* `ObliviousNullabilityAnalyzer.cs`
  that serve nullable-enabled C# and must be preserved when that file's fixpoint
  is removed. The file is not deleted wholesale; it is gutted.

So the accurate claim is: **the bug class is eliminated** — no site anywhere
reconstructs metadata origin from a bound-node shape, because the type carries it
— and the large line-count win is on the cs2gs side, provisionally ~7,000–7,300
lines pending the telemetry measurement (§10). The binder's win is structural
rather than numeric: on `main`'s baseline it is **one disjunct**.

### Cost the implementer must budget for

`NullableTypeSymbol` is referenced **334 times in `src/Core/CodeAnalysis/Binding/`
and 636 times across `src/Core/CodeAnalysis/`, in 94 files**. Every one of those
is a site where the implementer must decide whether `PlatformTypeSymbol` belongs
beside it. Most will not (the majority concern value-type `Nullable<T>` lifting,
which is untouched), but the audit is real and it is the single largest piece of
implementation work. A distinct symbol is still the right call — a flag on
`NullableTypeSymbol` would leave the same 636 sites each needing a *predicate*
rather than a *type test*, which is the defect this ADR exists to remove — but
the number belongs in the plan, not in a surprise.

## Explicitly out of scope

This ADR changes **nothing** about G#'s own nullability story:

- `T?` for a G#-declared nullable reference: unchanged, including GS0129,
  GS0154, and every conversion rule.
- `!!`, `?.`, `?[`, `??`, `??=`, `if let` / `guard let` / `while let`: unchanged
  in meaning and in lowering; they gain `T!` as an accepted operand.
- ADR-0069 smart-cast narrowing for G#-native code: unchanged. Issue #4310's
  bare-vs-qualified gap is untouched.
- Value-type nullability and `Nullable<T>` lowering: untouched.
- Annotated imported members, including the whole modern BCL: untouched.
- ADR-0155's C#-side migration rules, `Invariant.Required`, and the
  `nullable_hygiene.py` gate: untouched.

## Migration and compatibility

- **Existing G# source that already narrows an oblivious receiver keeps
  compiling, unchanged.** `x!!` on a `T!` is legal (§6) and emits the check the
  compiler would insert anyway; `if let v = x` binds; `x?.M()` works; `x != nil`
  narrows. Nothing that compiles today stops compiling because of a `T!`.
- **Most source gets more permissive, not less.** Sites that required `!!`
  and no longer do keep their `!!` harmlessly, and GS0536 is taught not to flag
  them. Cleaning them up is a separate, mechanical, optional pass.
- **One shape can select a *different* overload, and it must be flagged.** Given
  a **G#-declared** pair `func G(s string)` / `func G(s string?)`, the call
  `G(obliviousCall())` picks `G(string?)` today (the argument is `string?`) and
  `G(string)` under §3's tie-break (the argument is `string!`, and `T` beats `T?`).
  This is rare — it needs a G#-declared overload pair differing only in
  nullability, which CLR metadata cannot express — but it is *failure mode 5's
  shape*, the same line selecting a different method by typing, so "more
  permissive, never less" would be a false claim without it. It belongs in release
  notes and in the self-migration diff review.
- **Otherwise the change is permissive**: `Environment.Version.ToString()`,
  `s.ToUpper().Trim()`, `values.Min()` and `xs.Reverse()` all compile with no
  diagnostic where some of them previously errored — and `xs.Reverse()` now binds
  the method it binds for a non-nilable receiver, which is a *behaviour change on
  the miscompiling path* and must be called out in release notes.
- **Re-baseline, do not ratchet, on the first landing.** `nullAssertionCeiling`
  will move a long way; per ADR-0154 the PR that improves it tightens it.
- **A mutation witness is required for the central invariant** (§5): a test that
  binds `xs.Reverse()` on both a `List[int32]` and a `List[int32]!` receiver, with
  `System.Linq` deliberately imported, and asserts the two select the *same*
  method and produce the *same* mutation. Removing §5's projection must turn it
  red. Commit `359538cd` records why the `System.Linq` import is load-bearing:
  without `Enumerable` in scope the test passes either way and witnesses nothing.

## Consequences

### Positive

- **An entire defect class stops being representable.** No code anywhere
  reconstructs "where did this `?` come from" from a bound-node kind, a syntax
  availability, a member-stability classification, or a spelling. All six failure
  modes resolve from two invariants.
- **Silent miscompile becomes impossible for this category.** §5 makes the
  receiver's nullability an input that member lookup never sees, so it cannot
  select between two methods. This is the single most important property in the
  ADR: failure mode 5 was worse than the crash it was introduced to prevent.
- **The runtime failure is attributable at the boundaries where the CLR offers
  nothing** — an extension receiver, an argument, a store, a return — instead of
  an `ArgumentNullException` several frames inside a library.
- **cs2gs gets dramatically simpler and, more importantly, *exact*.** A
  whole-program fixpoint that guesses (most of a 5,385-line file) is replaced by a per-position
  read of the annotation state the C# compiler itself used — local, exact, and
  identical in every compilation that asks. The migration pipeline also stops
  loading every compilation in the repository on every run.
- **The metadata round-trip becomes total.** Oblivious G# declarations can be
  emitted as oblivious, which ADR-0136 could not express.
- **~12,000 `!!` in the self-migrated corpus lose their reason to exist**, and
  the remaining ones mean something.

### Negative

- **A compile-time guarantee is traded for a runtime one, for this category.**
  This is the trade, stated plainly. Three reasons it is the right one:
  1. *The guarantee was never real.* #4287's own bug shipped in full for every
     chained call for the life of the "fix"; the guarantee was a proof-shaped
     collection of predicates, and each new predicate created a new way to be
     wrong.
  2. *It is unobtainable in principle.* Oblivious means the information does not
     exist. Any compile-time answer is a guess. A guess wrong in the unsafe
     direction produces the crash anyway; a guess wrong in the safe direction
     produces false errors and 12,000 `!!`.
  3. *The failure mode it removes is categorically worse than the one it
     accepts.* A crash with an attributable message beats a silently different
     method call.
- **A nil can travel further before it surfaces.** A `T!` can be stored in a
  `T!` field and checked only much later. The mitigation — a check at every
  coercion to non-null — bounds this but does not eliminate it. Today's model
  bounds it more tightly *in principle* and, as the case studies show, not in
  fact.
- **A platform-typed generic container is as awkward as a nilable one.** §3
  permits only `C[T!] → C[T?]`, so a `List[string!]` cannot be passed to
  `func f(xs List[string])`. That is a real ergonomic cost and it is deliberate:
  the alternative is the aliasing unsoundness §3 documents. It is not a
  *regression* — ADR-0136 renders the same container as `List[string?]` and
  rejects the same call today — but it does mean the pivot's benefit is
  concentrated at the top level and in element-level access (rule 5), not in
  container conversion. It is also a place where G# is **stricter than Kotlin**,
  which permits the conversion and accepts the hole.
- **A third type category is more to hold in your head**, and it shows up in
  diagnostics, hover text, `DisplayFormat`, and the LSP. It is also 636
  `NullableTypeSymbol` sites' worth of audit.
- **"If it compiles, no NRE" weakens for interop-heavy code** — though it was
  never true, since a chained call, an extension receiver and a `[AllowNull]`
  setter each defeated it.
- **`--nullability=oblivious` / `@Oblivious` is new language surface** whose only
  consumer is a migration tool. It is deletable per project as migration
  completes, but until then it is a concept a G# reader may encounter and must
  understand.

### Neutral

- ADR-0136's `Issue3705MemberKindNullabilityDifferentialTests` — six signature
  positions × four annotation states — remains the standing uniformity gate. Its
  expected column changes in the oblivious row and nowhere else, which is a
  precise, mechanical statement of this ADR's entire metadata-reading change.
- Emitted IL grows by the inserted checks, and by **more** than an earlier draft
  claimed, since §4's receiver exemption did not survive review: receivers are
  checked too, with the CLR's own check making many of them elidable only once
  the emitter's opcode selection is unified (#4312/#4313). Sizing this is part of
  step 2's measurement, not an assumption.

## Alternatives considered

**1. Keep proving, and keep adding predicates.** Rejected — this is the status
quo, and PR #4308 is thirteen commits of evidence about where it leads. Each
round was individually reasonable and the sequence produced a silent miscompile.
The predicates have no unifying invariant, so there is no argument that the next
one is the last.

**2. Make `T!` a flag on `NullableTypeSymbol`.** Rejected. It answers the
question ("where did this `?` come from") correctly but leaves the answer
something every site must *ask*. All 636 `NullableTypeSymbol` sites would need a
predicate rather than a type test, which reproduces the failure-mode-1 drift
hazard with a better oracle. A distinct symbol means the sites that must not
treat it as nullable simply do not match.

**3. Erase `T!` to `T` (oblivious → non-null).** Rejected — this is the exact
pre-ADR-0136 behaviour ADR-0136 exists to end, and it fails the same way: `x ==
nil` becomes GS0129 on a value that is genuinely nil-able, and the compiler
admits as non-null something it has no evidence for.

**4. Check at callee entry rather than at the call site** (Kotlin's
`checkNotNullParameter`). Rejected for this ADR's scope: callee-entry checks
defend against *every* caller including foreign ones, which is strictly stronger,
but they touch every G# function rather than only interop boundaries, and they
change the contract of G#-native code this ADR is committed to leaving alone. The
cost of the call-site choice is stated in Open questions.

**5. Spell platform types in source (`T!` as writable syntax).** Rejected. It
breaks Kotlin's invariant that platform types are *inferred only* — the category
exists to represent the absence of an author's statement, and a spelling would
let an author state it, which is a different (and weaker) thing than `T?`. The
scope mechanism in §9 gets cs2gs what it needs without giving a hand-written
declaration a way to opt out of nullability per position.

**6. Infer obliviousness in cs2gs and keep emitting `T?`** (the status quo's
`IsTainted` fixpoint, improved). Rejected for ADR-0155 A9's reason, restated: a
property inferred from a program's *consumers* makes a library's public surface
depend on who calls it, can disagree between the project that declares a member
and the project that writes to it, and re-derives from weaker evidence a fact the
C# source already states per position. `NullableAnnotation.None` is that
statement; read it.

**7. Report a warning at every oblivious use and keep the `T?` model.** Rejected
as insufficient: it addresses the *ergonomics* of the proof obligation without
addressing the correctness defect, and failure mode 5 was a correctness defect in
the proof machinery, not in its ergonomics.

**8. Other ways to close the generic-aliasing hole (§3).** Two were considered
and rejected before settling on "one conversion, `C[T!] → C[T?]`, plus
element-level platform typing":

- *Restrict platform-flexibility to read-only / covariant-use positions.* This
  keeps mutual assignability but forbids it where the container is mutated
  through the converted view. Rejected on this ADR's own governing principle: G#
  has no general read-only-generic notion, so the rule would have to be a
  whole-type analysis over "does this type have a settable member of the relevant
  argument" — a predicate over shapes, added to preserve a convenience, which is
  exactly the machinery this ADR exists to delete. It would also have to answer
  the question again for every new container shape, which is failure mode 1's
  structure.
- *Check on read through a `T`-typed view, regardless of how the value was
  written.* This is sound, and it is the only option that preserves full mutual
  assignability. Rejected as both expensive and wrong-shaped: it puts a check on
  every field and property read of every generic instantiation, which abandons
  the boundary discipline that makes §4 one rule instead of a list, and it pays
  that cost on overwhelmingly non-platform code.

The chosen rule is strictly smaller than either: it deletes a conversion rather
than adding an analysis, and the ergonomics it appears to cost were already
absent under ADR-0136 (which renders the same container as `List[string?]` and
rejects the same assignment).

## Open questions for the implementer / reviewer

Ordered by how much a wrong answer would cost.

1. **§9's oblivious scope is the biggest new concept, and it is the one I am
   least certain about.** It mirrors C#'s `<Nullable>` + `#nullable` and Roslyn's
   `[NullableContext]` exactly, which is its main defence, and it avoids making
   `T!` spellable. But it introduces a mode in which the meaning of a bare `T` in
   a G# declaration depends on a compilation switch, which is a real language
   complication for a migration-only need. The alternatives are (a) make `T!`
   spellable and accept the Kotlin-invariant break, or (b) have cs2gs emit an
   `@Oblivious` annotation on every affected declaration with no compilation-level
   default, trading language surface for output noise. **Scrutinise this
   section first.**

2. **`nil` from an oblivious scope into an enabled non-null parameter has no
   translation, and this is a missing case rather than a timing risk.** §3's
   table gives `nil → T!`, which covers an oblivious sink. It does **not** cover
   an *oblivious caller* passing `nil` to an *enabled* callee's non-null `T`
   parameter — and that is precisely ADR-0155 A8's `f(null!)` pattern, which
   post-migration test projects (deliberately oblivious, per A5) use to exercise
   `ArgumentNullException` guards in enabled production code. Under this ADR as
   written there is simply no rule for it: `nil → T` is still an error, and `!!`
   cannot bridge a literal `nil` (A9). Three candidate answers, none chosen here:
   permit `nil → T` from an oblivious scope with a check at the boundary; require
   those tests to route through a `T!`-typed local; or accept that such tests must
   be rewritten. **This subsumes the earlier draft's "call-site vs. callee-entry"
   framing, which treated it as a parity risk to measure rather than a hole in the
   conversion table.** The volume is still unmeasured.

3. ~~**The receiver exemption in §4.**~~ **Settled — the exemption was wrong, and
   §4 now says so.** An adversarial review enumerated the emitter's
   opcode-selection sites and falsified the claim: `receiverIsClass` is
   `is StructSymbol rs && rs.IsClass` and `receiverIsInterface` is
   `is InterfaceSymbol`, so a *wrapped* receiver type, `string`, `Array`,
   non-virtual event accessors and method-group capture all emit `call` with **no**
   nil check today. The exemption is now specified as a *future optimization*
   whose prerequisite is unifying that opcode selection (#4312/#4313), not as a
   property the design may rely on. Recorded rather than deleted because it is a
   worked example of the failure mode this ADR warns about: a rule that is
   "provable from the emit shape, stated once, in one place" is worth exactly as
   much as the enumeration behind it, and mine had not been done.

4. ~~**Type-argument flexibility (§3).**~~ **Settled against the earlier draft —
   the rule was unsound and §3 is rewritten.** The draft made `Box[string!]`,
   `Box[string]` and `Box[string?]` mutually assignable, reasoning that erasure
   to one CLR type made the distinction unobservable. Erasure is what makes the
   hole *reachable*: two views alias one object, so a `Box[string?]` alias can
   write `nil` that a `Box[string]` view reads as non-null with no `T! → T`
   boundary anywhere. §3 now permits exactly one conversion, `C[T!] → C[T?]`, and
   relies on member access through a `C[T!]` receiver yielding `T!` elements for
   the ergonomics. **G# is deliberately stricter than Kotlin here**, which has the
   identical hole and accepts it as an interop price G# does not need to pay.

   *Residual, genuinely open*: ADR-0159's magic collections need checking against
   the corrected rule — specifically whether `map[K, V!]` and `[]T!` zero values
   and their `== nil` behaviour (GS0523) compose with rule 5's element-level
   platform typing. The unsoundness is closed; the interaction is unverified.

5. **Whether GS0592 should exist at all, and whether it should be on by
   default.** I proposed it opt-in and off by default so the design never breaks
   a build. A reasonable alternative is on-by-default-as-info for interop-heavy
   projects. I have no data on the volume it would report; on the self-migrated
   corpus it is plausibly in the thousands, which argues for opt-in.

6. **Elision and de-duplication of checks (§4).** I specified it as an
   optimization reusing GS0536's redundancy knowledge, but I did not verify that
   GS0536's analysis is available at the lowering stage where the check would be
   inserted, nor whether `AccessPath` identity is sound across a basic block for
   this purpose. If it is not, the first implementation should simply not elide
   and measure.

7. **Failure mode 6's `Enumerable.Min` case now throws a G# check instead of
   `ArgumentNullException`.** That is a better message but a *different exception
   type* than the library would have produced. For a `catch ArgumentNullException`
   somewhere up the stack this is a behaviour change. I judged it acceptable (the
   check fires where the *G# program* made the error, and `NullReferenceException`
   is what the same code shape already produces for an instance call), but it is a
   judgment call.

8. ~~**A contradiction inside cs2gs's own justification…**~~ **Settled
   empirically, and the conclusion reverses.** An earlier draft flagged that
   `ShouldPromoteToNullableReference`'s tail rule (#1072) is justified at
   `Nullability.cs:38–41` by *"gsc only permits `== nil` on a nullable operand"*
   while `Nullability.cs:158–161` says *"gsc admits `x == nil` on a bare reference
   class"*, and speculated the rule might therefore be unnecessary. **That
   speculation is unsafe and is withdrawn.** The GS0129 argument covers only the
   *comparison* half of what the rule protects; nil **assignment** — `x = nil`,
   `??=`, declarator and property initializers — is gated independently and
   remains load-bearing. The two comments are both about comparison and only one
   of them is stale; the rule stays in bucket (b) regardless. Fixing the stale
   comment is worth an issue; deleting the rule is not.

9. **The cs2gs line-count split is an estimate that has already been wrong once,
   in the flattering direction.** An earlier draft said ~8,300–8,600 deletable /
   ~1,900 surviving; review corrected it to ~7,000–7,300 / ~3,300–3,600, chiefly
   because file-level attribution (`ObliviousNullabilityAnalyzer.cs`) was
   conflated with role-level attribution — ~1,150–1,250 lines in that file serve
   nullable-*enabled* C#. Total surface (~10,300–10,700) was about right both
   times, which is exactly why the total is the safe thing to quote and the split
   is not. Every `ReceiverNeedsNullForgiveness` rule already records a distinct
   `NullForgivenessTelemetry` key. **Run that corpus measurement before any figure
   enters a planning document.**

10. **Overload re-selection on a G#-declared `G(string)` / `G(string?)` pair.**
    §3's tie-break changes which one `G(obliviousCall())` picks. I judged this
    acceptable — the `T` overload is the one a non-nilable argument would have
    picked, and CLR metadata cannot express such a pair so no imported API is
    affected — but it is the one place this design reproduces failure mode 5's
    *shape* (same line, different method, decided by typing), and it deserves a
    deliberate decision rather than a tie-break rule inherited by default. The
    alternative is to make a `T!` argument ambiguous against such a pair and
    require disambiguation.

11. **The binder change is one condition, not one block — and only if that block
    exists.** On `main` the deletion is a single disjunct
    (`|| receiver is BoundClrPropertyAccessExpression`); PR #4308's
    `nullableInnerVt is { IsValueType: false }` block is **branch-only** and not
    on `main` at all, so this item applies only in the world where that branch
    lands first. In that world the block **must not be deleted** — it is the only
    path reporting GS0159 for `this.name.ToUpper()` on a G#-declared `string?`,
    because `NullableTypeSymbol.ClrType` is non-null and the older fallback never
    fires (`b7856060`'s root cause). Only its `CanBindClrInstanceMember` conjunct
    goes. Stated in several places because it is the single easiest way to
    reintroduce #4287 while believing you are implementing this ADR; a reviewer
    should check the implementing PR's diff against whichever baseline is real at
    that time.

12. **§9 covers declaration *signatures* only, and that is corpus-wide
    insufficient.** The oblivious-scope mechanism as specified governs types,
    functions, properties, fields, events and parameters. cs2gs also renders
    **explicitly-typed locals**, and §9 says nothing about them — nor about `out`
    parameters, `foreach` variables, lambda parameters, or catch and pattern
    variables. Every one of those is a position where cs2gs writes a type today.
    This is not an edge case to discover during implementation; it is a
    substantial extension of §9's surface, and either the scope rule must reach
    every type-writing position uniformly (preferable — it is the same rule) or
    §9 must say explicitly which positions it does not cover and what cs2gs emits
    there instead.

13. **Conformance boundaries have no check point, and this pivot does not close
    them.** Interface implementation, delegate conversion and generic-constraint
    substitution are *signature relations*, not value conversions, so there is no
    expression at which a `T! → T` check could be inserted. A platform value can
    therefore reach a non-null position by implementing an interface whose member
    is declared `T`, or by conversion to a delegate whose signature says `T`, with
    zero check. **Kotlin has the identical hole**, which is evidence that it is
    inherent to the category rather than a defect in this rendering of it — but
    the ADR should not be read as claiming it closes every gap ADR-0136 cared
    about. It closes the *expression-level* ones, which is where all six failure
    modes lived, and leaves the conformance-level ones open. Callee-entry checks
    (Alternative 4) would close them; that is their strongest argument and is
    recorded here rather than in the alternative's own paragraph because this is
    the concrete cost of not taking it.

14. **The test surface is unaccounted-for scope, and it is larger than the
    production code being deleted.** Roughly **20,000–25,000 lines of
    `Cs2Gs.Tests`** reference the taint/oblivious machinery. One fixture —
    `Issue4167SelfHostedEnumPatternRegressionTests.cs:105` — is keyed on
    `ObliviousNullabilityAnalyzer.cs` existing *by name*, so it breaks the moment
    that file is gutted regardless of behaviour. None of this appears in
    *Implementation impact*, which discusses production lines only. Size it before
    committing to a schedule.

## Recommendation

Adopt. The decisive argument is not ergonomics and not line count — it is that
the current design's failure mode escalated from "crash the issue was filed
about" to "silently call a different method," and it did so *while being actively
and carefully fixed*. A design whose corrections produce miscompiles is not a
design with remaining bugs; it is a design whose premise — that a compiler can
prove safe what no one has stated — does not hold.

Suggested sequencing, each step independently landable and green:

1. `PlatformTypeSymbol`, display, and the `ClrNullability` three-state read,
   behind `--nullability=platform-types` defaulting **off**. No behaviour change
   when off; the differential test (ADR-0136's
   `Issue3705MemberKindNullabilityDifferentialTests`) gains its third column.
2. §3 conversions, §5a **and §5b**, §6 operator acceptance, and §4's coercion
   check. Land the §5 mutation witness with this step — it is the invariant the
   whole design rests on — and note that the witness must assert **both** clauses:
   that a `List[int32]` and a `List[int32]!` receiver select the *same method* and
   produce the *same mutation*, **and** that a symbolic/generic-substituted call
   (`Queue[Entry]!.Dequeue()`) keeps the *same result type* it has for a
   `Queue[Entry]` receiver. A witness that checks only selection passes while
   §5b is broken.
3. **Flip `--nullability=platform-types` on by default.** This step exists and
   must be named: while the flag is off, oblivious positions are still `T?`, so
   performing step 4's deletion first would transiently reinstate failure mode 1
   (`Environment.Version.ToString()` reporting GS0159 again, with main's
   property-read carve-out removed and nothing replacing it). The flip is the
   point at which the new model becomes load-bearing and the old carve-out becomes
   dead code — in that order, never the reverse.
4. Delete the old carve-out — on `main`'s baseline, the
   `|| receiver is BoundClrPropertyAccessExpression` disjunct; additionally
   `IsImportedClrChainReceiver` and the `CanBindClrInstanceMember` conjunct if PR
   #4308 landed first, **keeping that block's body**. Verify the #4287 regression
   suite still reports on G#-declared `string?` receivers, and that the
   `ListReverse` / `StringTrim` gate witnesses from `359538cd` stay green for a
   source-declared `List[int32]?`.
5. §9's oblivious scope — **covering every type-writing position, not only
   declaration signatures (open question 12)** — and §8's emit; verify the
   three-valued round-trip.
6. cs2gs: switch to the per-position Roslyn read, gut the fixpoint (**preserving
   the enabled-C# rules that share its file**), remove the oblivious half of the
   forgiveness insertion, re-baseline `nullAssertionCeiling`, and run the full
   self-migration gate. **This step is the real verification**: the corpus must
   stay at its `greenFloor` while the assertion count falls sharply. Budget the
   `Cs2Gs.Tests` surface (open question 14) here, not as a surprise.
7. Optional: GS0592, and retire `NullAssertionPolishPass` if measurement supports
   it.

Before step 1, two cheap measurements that change the plan's numbers rather than
its shape: the `NullForgivenessTelemetry` corpus run (open question 9), and a
count of the `Cs2Gs.Tests` references (open question 14).
