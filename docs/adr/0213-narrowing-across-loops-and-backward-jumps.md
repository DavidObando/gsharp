# ADR-0213: Loop and backward-jump narrowing from a syntactic region lower bound

- **Status**: Accepted (maintainer decision on PR
  [#5302](https://github.com/DavidObando/gsharp/pull/5302), 2026-10-24; the
  nine questions of section 23 were decided as recommended on the same
  day)
- **Date**: 2026-10-24 (accepted 2026-10-24)
- **Phase**: Compiler architecture (study roadmap item M1b, second half;
  implementation is tracked under
  [#5130](https://github.com/DavidObando/gsharp/issues/5130) as slices L0
  to L3 of section 20, or under a successor issue the maintainer opens)
- **Issue**: [#5196](https://github.com/DavidObando/gsharp/issues/5196)
- **Supersedes**: section 10 of
  [ADR-0208](0208-narrowing-as-flow-state-with-a-query.md) ("unchanged
  mechanism, deferred redesign") and its open questions 4, 6 and 7; the
  loop paragraphs of the #2943 addendum of
  [ADR-0069](0069-smart-cast-flow-narrowing.md) named in section 17
- **Related**: [#2189](https://github.com/DavidObando/gsharp/issues/2189)
  (compiler performance umbrella),
  [ADR-0208](0208-narrowing-as-flow-state-with-a-query.md) and its probe
  corpus [0208-narrowing-probe-corpus.md](0208-narrowing-probe-corpus.md),
  [ADR-0069](0069-smart-cast-flow-narrowing.md) (#2943 addendum: loop
  back edges; #4989 addendum: `goto` joins),
  [ADR-0154](0154-test-oracle-strength.md),
  [ADR-0166](0166-is-pattern-variables.md) and
  [ADR-0201](0201-align-if-let-statement-and-expression.md) (binding
  scopes), [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md) and
  [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md)
  (nullability funnel),
  [ADR-0203](0203-measured-compiler-throughput-and-bounded-parallelism.md),
  deferred narrowing issues
  [#5169](https://github.com/DavidObando/gsharp/issues/5169),
  [#5206](https://github.com/DavidObando/gsharp/issues/5206),
  [#5215](https://github.com/DavidObando/gsharp/issues/5215),
  [#5231](https://github.com/DavidObando/gsharp/issues/5231),
  [#5237](https://github.com/DavidObando/gsharp/issues/5237),
  [#5238](https://github.com/DavidObando/gsharp/issues/5238),
  [#5239](https://github.com/DavidObando/gsharp/issues/5239),
  [#5249](https://github.com/DavidObando/gsharp/issues/5249),
  [#5301](https://github.com/DavidObando/gsharp/issues/5301) (filed by this
  ADR: two hazards for the #5130 slice that lands R6); PRs
  [#5164](https://github.com/DavidObando/gsharp/pull/5164) (ADR-0208, whose
  commit 001ee4ff5 holds the draft this ADR starts from),
  [#5212](https://github.com/DavidObando/gsharp/pull/5212) (PR 1),
  [#5230](https://github.com/DavidObando/gsharp/pull/5230) (PR 2 slice 1),
  [#5247](https://github.com/DavidObando/gsharp/pull/5247) (PR 2 slice 2a),
  [#5213](https://github.com/DavidObando/gsharp/pull/5213),
  [#5214](https://github.com/DavidObando/gsharp/pull/5214),
  [#5211](https://github.com/DavidObando/gsharp/pull/5211) (the three
  soundness fixes in the current scheme).

## Context

### 1. Scope and the ADR-0208 baseline this document assumes

ADR-0208 made narrowing a forward flow-state computation with one join rule
and one construct table, and it kept today's loop and backward-`goto`
mechanism (its section 10) because four review rounds found defects only in
the entry-state rules for those two constructs. It deferred three
questions (4, 6, 7) and two table rows (R7, R8) to this ADR. This ADR
decides how a loop body and a backward-jump region get their entry state,
what is deleted, what users see change, and how the change ships.

It is written against ADR-0208 **as it will stand after the work in flight**,
not against `main` at the time of writing. The assumptions, each named so a
reviewer can check it when the in-flight work lands:

- **A1 (threaded state).** `BinderContext.Narrowing NarrowingState` is the
  state at the current program point. After #5230 it is threaded beside
  the frame stack and is a projection of the frames (the innermost frame
  wins); the #5130 slice that deletes the frames makes it the only
  mechanism. This ADR's kills are `NarrowingState`
  operations; where the frames still exist when a slice lands, the slice
  applies the same kill to the frames through the one entry point the
  legacy pass uses (`InvalidateInheritedNarrowings`), and the parity
  assertion `GSHARP_NARROWING_PARITY=1` covers the two.
- **A2 (one kill predicate).** The predicates that decide whether a bound
  effect removes a fact are single definitions shared by every consumer:
  `StatementKillsPath`, `DropsOnMemberMutation`, `MayBeMutatedByUnknownWrite`
  and `MayShareStorage` (introduced by #5214 and #5247), applied through the
  construct table of ADR-0208 section 8. This ADR adds no second
  definition of any of them. Its loop rule is parametric in them: whatever
  the straight-line rule kills for an effect, the region rule kills for the
  same effect found in the region.
- **A3 (the R12 amendment).** A P0 correction to ADR-0208 row R12 is in
  flight as PR [#5298](https://github.com/DavidObando/gsharp/pull/5298)
  (open at the time of writing) for issue
  [#5292](https://github.com/DavidObando/gsharp/issues/5292): a call does
  not drop a by-reference parameter's narrowing unless
  the parameter's storage is **alias-reachable** (the function has taken
  another alias of it, or the storage may be an element or member that
  code the call runs can reach through another path). This ADR does not
  restate that rule. Because of A2, the loop rule inherits it: the walker
  of section 7 reports "the region contains a call" and the shared
  predicate decides which alias-class facts that removes. The cost figures
  of ADR-0208 section 4 for the draft's call rule (22 errors in three Core
  functions, one of them `BinderContext.gs:906-923`, an `out` parameter
  read in a loop that calls `TryGetValue`) were measured under the
  unamended rule and are **not** quoted here as current; slice L0 measures
  them again under the shared predicate.
- **A4 (R6 pending).** The #4285/#4290 suppressions (a user label or `goto`
  anywhere in a function switches off lifts and joins) are removed by the
  #5130 slice that lands row R6. Section 3d explains why that slice and
  slice L2 of this ADR must be ordered.

Nothing here edits ADR-0208. Where this ADR changes a result that ADR-0208
section 16 or 17 records for a loop or backward-jump probe, section 16
below says so row by row.

### 2. The mechanism today

**Loops.** `BindLoopBody` (`src/Core/CodeAnalysis/Binding/StatementBinder.Jumps.gs:243-426`)
binds the body once under the inherited facts, lowers it, builds a
`ControlFlowGraph`, finds the writes that can reach the back edge
(`CollectLoopBackEdgeMutations`, `StatementBinder.Narrowing.gs:644-697`,
with a `reachesBackEdge` search from a marker block), and compares them
with the inherited facts (`CollectInheritedNarrowingInvalidations`,
`:616-636`). If any inherited fact is invalidated, or the external-callable
alias set changes, it restores 21 snapshotted structures
(`:287-319`, `:376-422`: the frames, two pending-frame maps, the user-label
set, the `goto` snapshot maps, the backward-`goto` states, the reachability
sets, the handler regions, the `finally` summaries, the cleanup stacks, the
synthetic-local counter), truncates the diagnostics
(`Diagnostics.TruncateTo`), removes the invalidated facts and binds the
header and body a second time (`bindIteration`, #4129). The proof that an
assignment keeps an inherited fact across the back edge is
`AssignmentPreservesNarrowing` (`:1291-1342`): a constructor call, a non-nil
literal, a variable the bound tree proves non-null, or a call to a source
function whose every `return` is syntactically non-null
(`FunctionReturnsDefinitelyNonNull`, which reads another function's body).
PR 1 of #5130 counted the second bind: `narrowing.loop-rebinds` is 62 on
Core, 0 on Core.Tests, 0 on gsc and 7 on the pinned Oahu inputs.

**Backward `goto`.** A label captures a `GotoNarrowingSnapshot`
(`GotoNarrowingSnapshot.gs`, 190 lines; `CaptureGotoNarrowingSnapshot`,
`StatementBinder.Jumps.gs:173-198`) and a `BackwardGotoNarrowingState`
(`DefineUserLabel`, `:73-103`). The region after the label is bound
optimistically. Every narrowing-dependent read records a
`BackwardGotoNarrowingAccess` with its frame index and proof generation
(`BinderContext.TrackBackwardGotoNarrowingUse`, `BinderContext.gs:814-890`;
the generations at `:762-788`). A later `goto` to the label adds an edge
with the source snapshot; after the function is bound,
`ReportUnsafeBackwardGotoNarrowings` (`StatementBinder.Narrowing.gs:938-1003`)
re-runs the cleanup transfers of the jump (`ApplyExitedFinallyEffects`)
and re-reports a diagnostic for each recorded access whose fact does not
hold at the source. Label reachability has its own fixed point
(`ActivateDeferredReachableGotoEdges`, `:144-171`), nested function literals
save and restore the whole structure (`LambdaBinder.gs:2238`, `:2470`), and
the loop snapshot above clones it.

### 3. The problem, precisely

**3a. Cost.** Every loop with an active narrowing pays a lowering and a
CFG, and 62 Core loop bodies are bound twice. The snapshot is O(state) per
such loop and the restore list is a maintenance hazard: five
`SpeculativeRebind_*` tests in `Issue2943LoopBackEdgeNarrowingTests` each
pin a past defect where a structure was missing from it (diagnostics,
lambda return diagnostics, the loop stack, the synthetic lambda ordinal,
`goto` handler diagnostics). The study's M1b target (no second bind of loop
bodies, `StatementBinder.Narrowing.gs` reduced to classifiers and transfer
functions) is not reached while this stays.

**3b. Irregular precision.** Three results depend on things a flow rule
should not depend on:

- *Construction syntax.* `x = Dog()` keeps a type-test fact across the back
  edge and `x = Dog{}` does not (`IsDefinitelyNonNullValue` lists
  `BoundConstructorCallExpression` and not `BoundStructLiteralExpression`),
  so the same program prints `dog` or `animal` by spelling (probes c8/c8b,
  [#5169](https://github.com/DavidObando/gsharp/issues/5169)).
- *Another function's body.* `FunctionReturnsDefinitelyNonNull` reads the
  callee's syntax, so editing `Make()` changes which reads in `Run()` bind,
  across files, with no interface between them (probe e3).
- *A per-loop CFG.* The exit-path exemption ("a write on a path that leaves
  the loop does not invalidate", probe e2b) is the one rule that needs the
  lowered graph. ADR-0208 section 4 measured it as load-bearing in zero
  functions of Core, Core.Tests and gsc.

**3c. Soundness.** The loop collector and the straight-line pass are two
implementations of "what does this code write". Every hole found in one
was also in the other, and each fix had to be made twice: #5170 (globals,
d3 and its loop form), #5171 (aliases, d4/f2/g2 and their loop forms),
#5168 (filters). Two holes are open at the time of writing and both have
a loop form:

- **q3** (this ADR's probe, the [#5237](https://github.com/DavidObando/gsharp/issues/5237)
  shape inside a loop; sources in section 24): a closure that assigns `x`
  escapes into a field; the loop reads `x.Value` and calls `Wrapper(h)`, a
  top-level function with no callable argument, which invokes the closure.
  0.5.212 compiles it and the program throws `NullReferenceException`. The
  callee classification that keeps closure-assigned locals across a call
  with "no captures and no callable argument" is unsound in straight-line
  code and in loops alike.
- [#5231](https://github.com/DavidObando/gsharp/issues/5231): an imported
  getter that runs user code is not a call for the alias class. Today's
  loop collector kills member paths on a source getter with user code
  (`AssignedRootsCollector.VisitExpression`, `:1751-1753`) but not on an
  imported one. Decided (ADR-0208 row R16): an imported getter is a call
  unless it is on the stable list (`StatementBinder.IsStableClrGetter`).

A single kill predicate (A2) closes both in loops the day it closes them
in straight-line code; two predicates keep the pattern of paired fixes.

**3d. The optimistic bind.** Binding a label region under facts that a
later jump may invalidate is correct only if every consumer of narrowed
state is tracked and can be re-reported after the fact. ADR-0208's
"Alternatives considered" names the consumers that cannot be: `GS0536`
(redundant `!!`) reported on an optimistic fact is wrong once the fact dies,
and warnings are errors; a `castclass` emitted for a type-test fact stays
in the IL; the ADR-0186 section 6 nil-check elision on a dead fact changes
where a nil fails. The checker tracks member, function, conversion, index
and non-null-use kinds (`BackwardGotoNarrowingUseKind`), not `GS0536` or the
elision. Probe **q2** (`if s == nil { return }`, `Again: i = i + s!!.Length;
s = nil; if i < n { s = Get(); goto Again }`) compiles clean on 0.5.212 and
prints `5` only because the #4285 suppression (A4) switches the guard lift
off in a function with `goto`, so `s` is not narrowed at `Again:`. Once the
R6 slice removes the suppression while the optimistic checker remains,
`s!!` is reported redundant on a fact that the back edge kills: a
correct program fails to compile with a diagnostic that tells the user to
make it incorrect. That is a sequencing hazard between #5130 and this
ADR, resolved in section 20 (L2 lands before the R6 slice, or the R6 slice
keeps the suppression inside backward-jump spans until L2).

A second shape the suppression masks today is a **forward `goto` into a
loop body**. Probe **q6** (`if skip { goto Inside }; if s == nil { return
0 }; while count < 3 && s.Length < 9 { Inside: count++ }`) is legal G#: the
binder accepts the jump and 0.5.212 rejects only the header read, because
the guard lift is off. Once the R6 slice restores the lift, the header
`s.Length` is bound under the guard's fact while the jump enters the body
without it, and the second evaluation of the header dereferences nil. The
loop's entry state must join that jump (section 6, J6 in section 10); the
R6 slice needs the same rule for the loop mechanism it keeps, or the
suppression kept for loops that contain a label targeted from outside.
Both shapes are filed as
[#5301](https://github.com/DavidObando/gsharp/issues/5301) against #5130;
q2 and q6 are its rows.

**3e. Loops, `finally` and `catch`.** `continue`, `break` and `goto` out of
a `try` inside a loop run the `finally` first; a `catch` inside a loop
re-enters the body; a throw out of the body enters a `finally` outside the
loop. Today's loop collector sees the lowered body, so these edges are in
its graph, and the backward-`goto` checker replays the cleanup transfers
(`ApplyExitedFinallyEffects`) before testing an edge. Probe cC
(`Again: let length = x.Length; ... try { x = nil; goto Again } finally { x
= "safe" }`) is accepted today and prints `4` because the replay applies
the `finally`'s write before the label is tested. Any design that computes
the entry state before the region is bound cannot model cleanup order
(which write runs last on the way to the jump) without the graph; it has to
decide whether cC stays accepted.

**3f. Reachability.** A label that fall-through does not reach may still be
reached by a `goto` bound later, and a `goto` after an unreachable label is
dead until its label becomes reachable. Today's fixed point over
`DeferredUnreachableGotoEdges` and `ReachableUserLabels` resolves this
after the function is bound. The replacement must give every label a
state before its region is bound, from syntax, without accepting more than
the current reachability rule (ADR-0208 section 6; probe d6 depends on it).

### 4. What is measured so far and what is not

| Input | What | Result | Source |
| --- | --- | --- | --- |
| Core, Core.Tests, gsc | kill every root the loop assigns, no non-null proof (draft rule 2 without rule 3) | 12 `GS0158`, one Core function (`ExpressionBinder.Assignments.gs:5435-5494`, `access = inner`, `inner` a pattern variable); 0 elsewhere | ADR-0208 corpus doc, experiments |
| Core, Core.Tests, gsc | same, keeping today's bound non-null proof | 0 errors | same |
| Core, Core.Tests, gsc | every call also kills closure-assigned and by-reference roots (draft rules 4 and 5, unamended) | 22 errors in three Core functions (`BinderContext.gs:906-923`, `MemberLookup.gs:1108-1120`, `:3100-3172`); 0 elsewhere | same; superseded by A3, re-measured in L0 |
| Core / Core.Tests / gsc / Oahu | `narrowing.loop-rebinds` | 62 / 0 / 0 / 7 | PR 1 (#5212) |
| 0.5.212 | probes q1 to q14 (section 24) | q3, q5d and q14 compile and throw `NullReferenceException`; q1, q5a, q5b, q6, q7, q8, q9, q10, q11, q12 rejected; q2 accepted, prints `5`; q4 accepted, prints `3`; q5c and q13 accepted, print `2` | this ADR |

Not measured yet, and therefore an output of slice L0 rather than an input
to this ADR: the comparison of the syntactic kill set of section 7 against
today's bound back-edge analysis on Core, Core.Tests, gsc and Oahu (the
second input ADR-0208 section 10 asked for; `NarrowingComparison.gs` and
`StatementBinder.NarrowingShadow.gs` compare joins only, not loop kill
sets); the number of loops that inherit a live member-bearing fact
(section 7, W5); and the number of backward-jump spans in Oahu (Core has
no user `goto`). The decisions marked *provisional* in section 23 are
re-confirmed against those numbers before slice L1 lands.

### 5. Constraints

Those of ADR-0208 section 5 (the maintainer's semantics-change approval,
the N-1 rule, byte-for-byte deterministic emit, the ADR-0193 funnel, the
language server's read of `NarrowedType` from the bound tree) and three
more:

- The maintainer's decision on #5206: do not break Oahu or other consumers.
  A less permissive row is acceptable when it closes a soundness hole or
  when its cost on Core, Core.Tests, gsc and Oahu is measured and listed
  before it ships.
- Binding stays single-pass. Section 1 of ADR-0208: the narrowed type is
  the type, so a body is bound once and nothing re-walks a bound tree to
  recover what the binder knew.
- Every rule is derived from the invariant of ADR-0208 section 6 ("a fact
  is in the state at a point only if it holds on every edge that reaches
  that point") and approximates toward fewer facts.

## Decision

### 6. The model: one bind under a region lower bound, no fixed point

A loop and a backward-jump region are the two constructs whose entry state
depends on code the binder has not bound yet. ADR-0208 section 6 already
gives the device: the region lower bound `Lower(S, R)`. This ADR applies it
to both constructs with the kill set computed **from syntax, before the
region is bound**, by the walker of section 7.

> For a region `R` (a loop's header, body and post statement; or a
> backward-jump span) with entry state `S`: `L = Lower(S, R)` is `S` with
> every fact removed that any effect the walker finds in `R` would remove
> under the shared kill predicate (A2). `R` is bound once, from `L`.

**Why there is no fixed point and no widening.** A dataflow fixed point
iterates because the state at the head depends on the state at the back
edge, which depends on the head. Here the dependency is cut by
construction. A fact on a root `r` is in `L` only in one of two cases:
no effect in `R` can write `r` (then `L.Kill(e) = L` for every effect `e`
of `R` on that fact), or every write to `r` in `R` is a P7 write (section
8) whose value has the fact's type (then every write re-establishes the
fact's truth even though the straight-line transfer after the write
records only the declared non-null type, ADR-0208 P2). Three consequences,
each used below:

1. **Every fact in `L` holds at every point inside `R`**, on the back
   edge, on every `continue`, on every exceptional edge out of a point in
   `R` and at every jump out of `R`. For the first case the state itself
   includes the fact everywhere in `R` (facts proven inside `R` are added
   on top and may be killed again; facts of `L` cannot be). For the second
   case the fact is true everywhere in `R` because every value written to
   `r` has its type, whether or not the state after the write records it
   (a read after such a write in the same iteration sees the state's
   weaker fact, as it does today).
2. **The header is bound once, under `L`, and its result is a lower bound
   for every evaluation.** The entry evaluation runs under `S`, whose facts
   include `L`'s; every later evaluation runs under a back-edge state at
   which every fact of `L` holds, by (1). The condition's then- and
   else-states computed from `L` are therefore sound for every iteration
   (P1 is monotone in its input state).
3. **Termination is trivial.** One syntax walk per region, one bind. There
   is nothing to iterate and nothing to widen. The only "iteration" in
   this area today, the re-bind, is gone.

**What `S` is.** `S` joins **every edge that enters `R` from outside**:
the fall-in state at the region's first statement and the state of every
forward `goto`, recorded before `R` is bound, from outside `R` to a label
inside `R` (section 11; this includes a forward jump into a loop body,
which is legal G#, probe q6, and whose state may lack facts the loop
header was bound with: without this clause the header's lower bound would
not be a lower bound for the first evaluation after such an entry). Back edges and
jumps internal to `R` are not in `S`; (1) covers them. Edges from dead
code record nothing (ADR-0208 section 6, reachability).

**Facts proven inside `R`** (`while x != nil`, a guard, a P2 assignment, a
`[MemberNotNull]` post-condition) are per-iteration facts and flow forward
exactly as in straight-line code. e13 keeps compiling; a guard directly
after a label re-establishes narrowing for the code after it.

**Nullability facts and type-test facts** are one kind of fact for the
kill rule: a root the region may write loses both. They differ only in
the proof rule P7 (section 8): a syntactic non-null value keeps a
nullability fact and keeps a type-test fact only when the value's
syntactic type converts to the fact's type. The state stores `TypeSymbol`s
and asks "strip one nullable layer" through the ADR-0193 readers; this ADR
adds no nullability computation. `PlatformTypeSymbol` (`T!`) and
`NullableTypeSymbol` (`T?`) stay distinct (ADR-0186); a fact on a `T!` root
is killed and kept by the same rules as any other.

**The exit state of a region** is an ordinary join (ADR-0208 P5, the n-ary
`JoinJumps`), never a lower bound: its predecessors (the header's
else-state, `break` states after their pending cleanup transfers) are all
known when the region's binding ends. Section 9 gives it per loop kind.

### 7. The region walker: the construct table applied to syntax

The kill set is computed by `RegionEffectScanner` (name indicative), a
syntax walker that maps each syntax kind to the effect class of the bound
kind it binds to (ADR-0208 section 8, construct table) and composes
bottom-up. It generalises `CollectAssignedNamesAndMemberMutation`
(`StatementBinder.Narrowing.gs:4017`) and `SyntaxMayMutateMemberPaths`
(`:496`), which L1 retires, and it can serve the `when`-filter scan of
ADR-0208 section 10, which is #5130's code and may be consolidated onto
this walker in L3. Its output for a node is a `RegionEffects` record:

- `AssignedNames`: names written by a root-write effect in the node and
  **not** declared by a declaration in the node that lexically encloses
  and precedes the write (rule W1), with the syntax position of each
  write; resolved to symbols at the region's entry scope by the consumer.
- `NonNullAssignments`: the subset of those writes whose right side passes
  P7 (section 8), with the proven type.
- `DeclaredNames`: names the node declares, with their scope extents, for
  W1 composition.
- `Calls`: one entry per call-class site (W4, W5), carrying what the shared
  predicate asks of a call: the call category (invocation, construction,
  getter, iteration, cleanup, suspension, user-defined operator), the
  receiver's and each argument's root resolved at the region's entry scope
  with its declared type, each argument's `ref`/`out`/`in` mode, and an
  `Unresolved` mark for every operand the walker could not resolve to a
  variable. The alias-reachability predicate of A3 (PR #5298's
  call-reachability test, which examines operand types to decide whether a
  call can reach a by-reference parameter's storage) is answered from
  these entries; an `Unresolved` operand is answered as "may reach any
  storage", the most destructive answer, so `ReadOnly()` and `Mutate(xs)`
  give different kills when `xs` resolves and the same kill when it does
  not.
- flags, as in `StatementEffects` (ADR-0208 section 13):
  `ContainsCall`, `ContainsMemberWrite`, `ContainsMemberRead`,
  `ContainsPointerWrite`, `ContainsAliasTake`, `ContainsRefOrOutArgument`
  (with the argument names), `ContainsClosure`, `ContainsSuspension`,
  `ContainsHandler` (a `catch` clause inside the region, W8),
  `ContainsUnknownKind`.

The rules, each an instance of the construct table and of the lower bound:

- **W1 Scope-aware names.** A write to a name declared inside the region,
  by a declaration that lexically encloses and precedes the write (`var`/
  `let`, a `for` header variable, a pattern variable, an `if let`/`guard
  let`/`while let` binding, a lambda or local-function parameter, a
  `catch` variable, a `for ... in` element), is region-local and does not
  kill the outer variable of the same name (e16 keeps compiling). A write
  to any other name is resolved at the region's entry scope with
  `$scope.TryLookupSymbol`; a name that resolves to a variable kills every
  fact on that root (and, if the root is in the alias class, the shared
  predicate decides what else); an unqualified name that resolves to a
  field or property of the enclosing type (an implicit `this` member) is a
  member write (`ContainsMemberWrite`; the implicit-field path and every
  other member-bearing path die). A declaration form the walker does not
  recognise declares nothing, which kills the outer variable; a name that
  resolves to nothing kills nothing (the state cannot hold a fact on it).
  This is the symbol-identity rule of #2943 and the fix direction of
  [#5239](https://github.com/DavidObando/gsharp/issues/5239) applied to
  regions.
- **W2 Every write in the region counts.** A write on a path that leaves the
  region (`break`, `return`, `throw`, `goto` out) kills like any other.
  This removes the per-loop lowering, the CFG and the `reachesBackEdge`
  search. Cost: zero load-bearing sites in Core, Core.Tests and gsc
  (section 4); row R7 (a).
- **W3 Writes through aliases.** An `out`/`ref` argument and an `&`
  operand are root writes of the resolved variable; a `ref` local
  declaration puts the local and its initializer's root in the alias
  class; the shared predicate (A2, A3) decides which alias-class facts a
  member write or a call in the region removes. The walker reports the
  facts (`ContainsCall`, `ContainsMemberWrite`, the written names); it
  does not restate the alias rule.
- **W4 Any call is `call`.** An invocation, a construction with user code,
  a `yield` or `await` (ADR-0208 R13), a `for ... in` header (`MoveNext`,
  `Current`, disposal; probe f5), a `using`/`defer`/`lock` cleanup, a
  user-defined operator or conversion that the walker cannot rule out, an
  interpolated string: all `call`. The walker never classifies callees.
  Before the region is bound, nothing that would justify an exemption is
  invariant over the region (probes c5, c6, c7, cB; q3 shows the "top-level
  callee without callable arguments" exemption is unsound even in
  straight-line code). What `call` removes is the shared predicate's
  answer (A2, A3): member-bearing paths, mutable globals, closure-assigned
  locals, and the alias-class facts the amended R12 names.
- **W5 Member reads.** A member access or index read is reported as
  `ContainsMemberRead`; **every member or index read in a region is an
  unknown getter**, and the kill it causes is the shared predicate's
  classification of an unknown getter (A2; ADR-0208 row R14: a getter with
  user code is a call; the open decision of
  [#5231](https://github.com/DavidObando/gsharp/issues/5231) on imported
  getters is made: ADR-0208 row R16, one list, `StatementBinder.ClrPropertyReadRunsUserCode`). The walker resolves nothing
  about the member. This ADR defines **no exemption**, and the reason is a
  derivation, not a measurement: an exemption would need the walker to
  prove, before the region is bound, that the read binds to a member that
  runs no code, and the binder makes that selection only after the
  narrowing facts proven inside the region are known. The rows below are
  the cases such a proof would have to cover; the right column is what
  defeats a lookup on the receiver's declared type at the region's entry
  scope:

  | Read as resolved at the entry scope | Why the read inside the region may run code |
  | --- | --- |
  | field on a class or struct | a type-test fact inside the region (`if b is Derived { b.Count }`) selects a hiding computed `Derived.Count` (`ExpressionBinder.Access.MemberLookup.gs:810-887`) |
  | auto property, not `open` | the same hiding; and a later edit can make it `open` or give it a body without touching the region |
  | `open` or `override` auto property | a derived getter with a body (`Issue4312ReferenceReceiverAccessorOpcodeTests.gs:218-226`) |
  | member on a `sealed` class | G# `sealed` permits subclasses in the declaring assembly (ADR-0078 section 4); only CLR non-inheritability (`!IsOpen && !IsSealedHierarchy`, `TypeDefEmitter.gs:518-519`) rules a derived getter out, and the walker would have to prove it per receiver |
  | member on a struct | no hiding, but a struct member can be a computed property or an interface implementation the region reaches through a boxing narrowing |
  | interface member | always dispatches |
  | extension member | an instance member on the narrowed type shadows it, or the reverse |
  | member on a type parameter | dispatches through the constraint |
  | array element on a receiver whose declared type is an array | no code; but a receiver whose declared type is not an array (`object?` narrowed to `[]int32` inside the region) is not found as an array at the entry scope, and an indexer on any other receiver is a getter |
  | imported member of any kind | #5231, decided in ADR-0208 row R16: a call unless the getter is on the stable list (`StatementBinder.IsStableClrGetter`) |

  The one row that is `none` under every column (an element of a
  receiver declared as an array) is not worth a second rule. If slice L0
  finds that the strict rule rejects repository or Oahu sites, an exemption
  is proposed as a construct-table change under ADR-0208 section 8, with
  the rows above as its proof obligations and its own corpus rows and
  mutants, and it applies to the straight-line read of the same member
  too, because the kill is the shared predicate's.
- **W6 Closed kind list.** A syntax kind the walker does not list sets
  `ContainsUnknownKind`, and a region with that flag is bound from
  `NarrowingState.Empty`: every fact is removed. This is stronger than the
  `call` default of ADR-0208's construct table and filter scan, on
  purpose: a bound node of unknown kind has children the table still
  classifies, while an unknown syntax kind can hide a write to a plain
  local that `call` would not remove. A test enumerates every `SyntaxKind`
  (or `SyntaxNode` subtype) against the walker's list, so a new kind fails
  the test until someone decides its effect.
- **W7 Nested regions and closures.** A nested loop's or span's effects are
  its children's effects; a function literal's body is walked for
  `AssignedNames` (a closure that assigns a root is a write in the region;
  the root is also in the function-wide closure-assigned set) and its
  creation is `none`. Nothing inside a nested function body other than
  writes to captured names is attributed to the region.
- **W8 Enclosing `when` filters.** A `when` filter of a `try` that
  encloses the region runs in the first pass of an exception thrown
  inside the region, before any `finally` and before a `catch` inside the
  region handles the replacement exception that a `finally` may throw
  (ADR-0208 section 9, probe f3). If a `catch` inside the region then
  completes normally, execution resumes inside the region with the
  filter's writes applied, and the back edge carries them, although no
  syntax of the region wrote the root. So a region with `ContainsHandler`
  (a `catch` clause anywhere inside it) adds the function-wide filter
  write set (ADR-0208 section 10's scan, `FilterWrites`, which applies this
  same walker to every `when` filter of the function) to its own record.
  A region without a `catch` needs nothing: an exception that leaves the
  region never comes back to its back edge. Probe q14 (the f3 shape inside
  `while s.Length > 0 && n < 2`, inner `catch (InvalidOperationException)`
  falling through, outer `catch (FormatException) when Clear(ref s)` with
  `Clear` storing nil and returning true) is the witness: the header is
  evaluated with `s` nil after the inner handler resumes the loop.

**From `RegionEffects` to `L` (the consumer rule).** For each fact in `S`
on a path with root `r`, in this order: (i) if `ContainsUnknownKind`, drop
(W6); (ii) if the path is member-bearing and `ContainsMemberWrite`,
`ContainsCall`, or an unresolved member read is present, drop (the shared
predicate's member-path rule, `DropsOnMemberMutation`); (iii) if the path
is member-bearing and `r` is in `AssignedNames`, drop (a root replacement
kills every descendant path, whatever the new value is: `b = Box{}` after
a guard on `b.Pet`); (iv) apply the shared predicate for every effect the
record reports to `r`'s fact, exactly as the straight-line pass applies it
to a statement with those effects: `ContainsCall`, `ContainsMemberWrite`
(R12: a member, index or indirect write kills the alias class, `MayShareStorage`),
`ContainsPointerWrite`, `ContainsRefOrOutArgument` on `r` or on a member of
its alias class, `ContainsAliasTake` on `r`, each entry of `Calls` with its resolved
operands (an `Unresolved` operand answers the alias-reachability question
of A3 as "may reach any storage"), the filter write set when
`ContainsHandler` (W8), and every root `w` **other than `r`** in
`AssignedNames` with `MayShareStorage(w, r)` (a write to `x` kills the facts
of a `ref` local `a` that aliases `x`: probe d4; `MayShareStorage(r, r)` is
true by `SharesStorage`, so the identical root is excluded here and its
direct writes are decided by (v) and (vi)); any of these that the
predicate says kills, drops; (v) if `r` is in `AssignedNames` and some
write to `r` is not in `NonNullAssignments`, drop; (vi) if `r` is in
`AssignedNames` and every write to `r` is in `NonNullAssignments`, keep
the nullability fact, and keep a type-test fact only when every write's
proven type converts to it by identity or an implicit reference conversion
(section 8); (vii) otherwise keep. Steps (ii) to (iv) run before P7 is
consulted, so P7 can only keep a plain-root fact whose root no other
effect touches; only (vi) distinguishes `AssignedNames` from
`NonNullAssignments`, and everything else is a membership test or a call
into the shared predicate.

**Composition and cost.** `RegionEffects` is composed bottom-up and cached
per syntax node in a per-body side table (`Dictionary[SyntaxNode,
RegionEffects]` by reference, or a `ConditionalWeakTable`), so a nested
loop's walk is reused by the enclosing loop and every node is visited once
per body: O(size of the function) for all regions together, not
O(depth × size). The walk runs only when the entry state is non-empty
(today's `HasActiveNarrowings` guard, now `!S.IsEmpty`; a loop entered with
no facts has nothing to kill). The ordering of names inside a record is
declaration order; the consumer only tests membership, so no result
depends on iteration order (section 14).

### 8. Proof rule P7, adopted: syntactic non-null value for exact storage

ADR-0208 section 8 lists P7 "so that the proof list stays closed when this
ADR lands". This ADR adopts it as written there and fixes its remaining
details:

- The target must resolve (W1) to a root that
  `SmartCastStability.IsAssignmentNarrowingRoot` accepts: a local with
  `RefKind.None` or a global (`SmartCastStability.gs:41-47`); never a
  `ref`/`out`/`in` parameter, a `ref` local, or any root in the alias
  class. Without this restriction the `out-alias` row would be accepted
  and dereference nil. Parameters are not accepted by the current
  predicate; this ADR does not widen it.
- The right side is one of: a non-nil literal of a reference type; a
  construction `T(...)` or `T{...}` where `T`, resolved by the scope-aware
  walk at the assignment site, names a reference type (class, interface,
  delegate or function type; a CLR class counts) and no variable, parameter
  or function (a local callable shadowing a type name takes call-binding
  precedence: probe d2 stays rejected), and the target's declared type is
  `T` or a type `T` converts to by an implicit reference conversion;
  or `value!!` (nullability only). "Reference type" and "one nullable
  layer removed" are asked through the ADR-0193 readers.
- A value-type construction is not proof (`System.Nullable[int32]()` boxes
  to nil: probe f4 stays rejected). A variable, a call, a user-defined or
  unknown conversion, a `??`, a `?:`, a cast: not proof (decided question
  1 for calls; question 4 for pattern-bound names). `FunctionReturnsDefinitelyNonNull`,
  `IsDefinitelyNonNullSyntax` and the bound-tree variable proof are
  deleted with the collector.
- The proof keeps a nullability fact, and a type-test fact when `T`
  converts to the fact's type by identity or an implicit reference
  conversion (`x = Dog{}` keeps `x -> Dog` and `x -> Animal`; `x = Cat{}`
  keeps `x -> Animal` and drops `x -> Dog`:
  `NonNullAssignmentToDifferentSubtype_InvalidatesTypeNarrowing` keeps its
  result).
- Both construction syntaxes count (row R7 (d); closes #5169).

A P7 assignment inside the region is **also** a P2 assignment when it is
bound (the straight-line rule): for a nullable root it re-establishes the
nullability fact at the assignment's own point, at the declared non-null
type and never the assigned class (ADR-0069 #4989 addendum); for a
non-nullable root it adds nothing. So a type-test fact kept by P7 holds
semantically after the write (section 6, case two) but the state records
the declared type there, exactly as today: a hidden-member read after
`x = Dog{}` in the same iteration selects the declared type's member, one
before it selects the narrowed type's (row R7 (d)). P7 decides only
whether a fact survives *into* the region's entry.

P7 accepts a global root, but a region whose writes to a global are all
P7 keeps the global's fact only if the region contains no call (step (iii)
of the consumer rule: ADR-0208 R11, #5170). `NonNullAssignmentAfterUse_
OnTopLevelVariable_ReportsNullableReceiver` keeps its rejection for that
reason (the body calls `c.Print()`), not because of P7.

### 9. Transfer table: loops

Notation: `S` is the entry state (section 6), `L = Lower(S, R)`, `E_B` the
body's exit state, `Jmp(label, s)` the n-ary `JoinJumps(label, s)` over
`s` and every state recorded on `label` after pending cleanup transfers
(ADR-0208 section 9). "Header" means every expression the loop evaluates
per iteration. A loop statement is `region` in the construct table; its
own effects, for an enclosing region or `try`, are the union of its
children's plus `call` where the row says the header calls.

| # | Loop | `R` | Header state | Body state | Post / tail state | Exit state |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | `while c { B }`, `for c { B }` | `c`, `B` | `c` bound under `L` → `L_t`, `L_f` (P1) | `L_t` | none | `Jmp(break, L_f)` |
| T2 | `while let p = e { B }` | `e`, `p`, `B` | `e` under `L`; `p` is a scope fact (P4); `L_t`/`L_f` from P1 on `e` where it classifies | `L_t` | none | `Jmp(break, L_f)` |
| T3 | `for init; c; post { B }` | `c`, `B`, `post` (not `init`) | `init` is an ordinary statement before the region, bound under the state before the loop; its exit is `S`. `c` under `L` → `L_t`, `L_f` | `L_t` | `post` under `Jmp(continue, E_B)` (its predecessors are exactly the body exit and the `continue`s; this is a join, not a bound) | `Jmp(break, L_f)` |
| T4 | `for { B }`, the ellipsis form | `B` | none | `L` | none | `Jmp(break, Unreachable)`: `Unreachable` with no reachable `break` |
| T5 | `for x in xs { B }`, tuple form, `await for` | iteration (`MoveNext`, `Current`), `x`, `B`, disposal | `xs` is evaluated once, before the region, under the state before the loop (its effects applied give `S`). The iteration is `call` (W4, probe f5), which on `L` is the identity. `x` is declared in `R` (W1) | `L` | none | `Jmp(break, L).Kill(call)`: disposal runs on every exit, `break` included |
| T6 | `do { B } while c` | `B`, `c` | `c` bound under `Jmp(continue, E_B)` → `C_t`, `C_f` (its predecessors are exactly the body exit and the `continue`s) | `L` (the first entry carries `S`, but the body is also entered by the back edge, so it is bound under `L`; probe q8 stays rejected) | none | `Jmp(break, C_f)` |
| T7 | channel receive loop (`StatementBinder.Channels.gs:248`) | receive, `x`, `B` | as T5; the receive is `call` | `L` | none | as T5 |
| T8 | labelled loop (ADR-0070 `name: for ...`) | as the underlying kind | as the kind | as the kind | as the kind | as the kind; `break name`/`continue name` from an inner loop record on this loop's labels through the inner loop's pending cleanup |

Reading the table: the `continue` label's join is **consumed** only where a
statement follows it inside the region (`post` in T3, `c` in T6); in T1,
T2, T4, T5 and T7 the `continue` states flow to the header, which is bound
under `L`, and (1) of section 6 makes them `⊇ L`, so recording them has no
effect on binding (the implementation may still record them for a future
per-position query, ADR-0208 section 14). A header or body that cannot
complete (`return` on every path) yields `Unreachable` exits as in
ADR-0208 section 12.

Probes for the table: e13 (`while node != nil` re-proves per iteration;
accepted), e4 (nullable reassignment in the body; rejected), e16 (shadowed
`var s` in the body; accepted), q7 (`while s != nil { if c { break } s =
Next(s) }; s.Length`: `L_f` lacks the fact, the `break` state has it, the
join drops it; rejected today and after), q12 (`while s == nil { s = "ok"
}; s.Length`: `L_f` has the fact and there is no `break`, so the exit has
it; rejected today, accepted after, row R7 (f)), q8 (`do { s.Length; s =
Next(s) } while ...`; rejected today and after), f5 (iterator header assigns a
global; rejected), e12 (a loop inside an `if` branch contributes its exit
state to the `if` join; accepted).

### 10. Transfer table: jumps and the constructs they cross

| # | Construct | Transfer |
| --- | --- | --- |
| J1 | `break` [`name`] | records the current state on the target loop's break label, through the cleanup regions between the jump and the loop (ADR-0208 section 9); yields `Unreachable` |
| J2 | `continue` [`name`] | records on the target loop's continue label through pending cleanup; yields `Unreachable`; consumed per section 9 |
| J3 | `return`, `throw`, `rethrow`, throw expression | as ADR-0208 (`jump`); a `finally` inside the loop that the jump crosses is bound under its own lower bound (ADR-0208 section 9), which is `⊇ L` by (1) |
| J4 | forward `goto` from inside a region to a label after it | an ordinary jump state on that label through pending cleanup (ADR-0208 section 9); the label's entry is `Jmp(label, fallThrough)` |
| J5 | forward `goto` from inside a region to a label inside the same region | ordinary jump state; both states are `⊇ L` |
| J6 | forward `goto` from **outside** a region to a label **inside** it (bound before the region) | its recorded state is a predecessor of the region's entry state `S` (section 6) **and** of the label's own `Jmp`; if the target label is in a backward-jump span, section 11 applies |
| J7 | backward `goto` (to a label at or before the `goto`, in the span of section 11) | records no state; the target is a participant label and its entry is the span's lower bound `L`, and so is the span's first statement. A backward `goto` from inside a loop body to a label before the loop is J7 for the span, which contains the loop; a backward `goto` from after a loop to a label inside its body is J7 for a span that starts at the loop statement, so the loop header is bound from `L` and the jump cannot invalidate it (probe q11) |
| J8 | `goto` from an unreachable point, or whose path to its label leaves a cleanup region that cannot complete normally (a `finally` ending in `return`, `throw`, `goto`, `break` or `continue`, with the label outside that `try`) | records no edge and is not a participant (section 11; probe d6 stays accepted and prints `4`). A `goto` to a label inside the same `try` runs no `finally` and is a live edge (probe q10) |
| J9 | `yield`, `await` inside a region | `call` (ADR-0208 R13); on `L` the identity; kills facts proven inside the region before the suspension as in straight-line code |
| J10 | `defer`, `using`, `lock` inside a region | cleanup regions with an empty handler list (ADR-0208 section 9): their cleanup is `call` (W4) |
| J11 | `try`/`catch`/`finally` inside a region | the handler and `finally` entries are `Lower(S_try, T ∪ ...)` as ADR-0208 section 9 states, with `S_try ⊇ L`; a `catch` that completes normally re-enters the body with its exit state (a join predecessor like any other); a `continue`/`break`/`goto` out of the `try` goes through the `finally`'s exit transfer before its target joins it |
| J12 | region inside a `try` | the enclosing handler's lower bound is computed from bound effects after `T` is bound (ADR-0208 section 9); the region's bound effects include its header's `call` where the table says so (T5, T7) |

Probes: `Issue4519GotoAssignmentNarrowingTests` `GotoLeavingTry_*` and
`*Finally*` rows (J3, J4, J11); cC (J7 with J11: the span's kill set holds
`x = nil`, so the label loses the fact; section 16, R8 (a')); d6 (J8);
q9 (a loop inside a span whose body assigns nil; rejected today and after).

### 11. Backward jumps: the span rule

A backward `goto` is a back edge whose region is not delimited by syntax.
The region cannot be "the label through its last `goto`" alone, because a
label can be entered by a forward jump that bypasses the facts the
fall-through path proved (probe c3a) and a write outside that interval can
return to the label through another label (probe c3b). The rule, from the
ADR-0208 draft, with one addition (entry edges into any participant,
section 6):

- **Span.** The backward-jump span of a function is the run of consecutive
  statements, in the statement list of the shallowest participant, from
  the statement that holds the earliest label some later `goto` targets
  through the statement that holds the last such `goto`. Every label inside
  the span is a participant, whether or not it is itself a backward target,
  because a jump to it can feed the cycle. Disjoint spans may be treated as
  separate regions; merging them is also correct. The span is computed
  from syntax once per function, before binding, by the walker (it needs
  only labels and `goto`s).
- **Participants.** A `goto` that records no edge under the reachability
  rule (J8) is not a participant: one at an unreachable point (after an
  unconditional exit with no label between, in the same statement list), or
  one whose jump **leaves** a `try` whose `finally` syntactically ends in
  `return`, `throw`, `goto`, `break` or `continue`, that is, the `finally`
  lies on the path from the `goto` to its label (the label is outside the
  `try` and the `goto` inside it). A `goto` to a label inside the same
  `try` does not run that `finally` and is a live back edge whatever the
  `finally` ends in (probe q10: `try { Again: i = i + s.Length; s = nil;
  if i < n { goto Again } } finally { return i }` is a span and `s.Length`
  is rejected). When the walker cannot tell, the `goto` counts, which only
  adds kills. Probe d6: `goto Enter` sits in a `try` whose `finally {
  return 4 }` cannot complete and `Enter` is outside that `try`, so there
  is no edge, no span and no region; `Enter: x = nil; goto Use` is dead and
  records no edge; `Use` has no reachable incoming edge and is bound under
  the facts in force, so `x.Length` binds and the program prints `4`.
- **Entry state.** `S` is the join of the fall-through state at the span's
  first statement and the recorded state of every forward `goto` from
  before the span to any label inside it (J6). Both are known before the
  span is bound.
- **Span entry.** The span is a region like a loop: its **first statement**
  is bound from `L = Lower(S, span)`, with the kill set computed by the
  walker over the whole span (W1 to W7), and every participant label has
  entry state `L` as well. Binding the first statement from `L`, not only
  the labels, matters when a participant label sits inside a statement
  that has code before the label: a loop whose body holds the label. A
  backward `goto` from after the loop to that label enters the body
  without passing the header, so the header must have been bound under a
  state the jump cannot invalidate; `L` is that state (probe q11: `while
  count < 3 && s.Length < 9 { Inside: count++; i++ }; s = nil; if i < n {
  goto Inside }`: the span starts at the `while` statement, `s = nil` is in
  the kill set, and the header read is rejected). The loop's own entry
  state is then derived from `L` and its own lower bound is applied on top
  (nesting, below). Jumps between labels inside the span are internal (J7,
  J5); jumps from inside the span to labels after it are ordinary (J4). A
  guard after a label re-proves facts for the code after it
  (`BackwardGoto_StackedLabeledGuardReestablishesNarrowing` keeps running).
- **Reachability.** A participant label is reachable when fall-through
  reaches it, a forward `goto` recorded an edge to it, or a participant
  `goto` targets it. The last clause is syntactic and may count a `goto`
  that is in truth dead; the effect is a label bound under `L` instead of
  under "the facts in force", which is less permissive and sound. This
  replaces `DeferredUnreachableGotoEdges`, `ActivateDeferredReachableGotoEdges`
  and `PotentialReachabilityLabel`.
- **Nesting.** A span inside a loop body, a loop inside a span, a span
  inside a span's statement: each region applies its own lower bound at
  its own entry; an inner region's kill set is a subset of the outer's
  because its syntax is. Labels are per function body; a nested function
  literal has its own labels and its own spans (the save and restore of
  `BackwardGotoNarrowingStates` in `LambdaBinder.gs:2238, 2470` is deleted).

For c3a the forward jump to `Inside` enters the span without the fact, so
`S` lacks it and `Again` is bound without it. For c3b the write at `C` is
inside the span, so the kill removes it. For e18/Run the span holds no
write, so `L = S` and `s.Length` binds (accepted after; today rejected by
#4285). For e15 the span's only write is `s = "ab"`, a P7 literal on an
exact-storage root, so the fact survives and `s.Length` binds (accepted
after; today rejected by #4285). For e18/Run2 the write `s = Get()` is
nullable, so the fact dies at `again` and the guard after the write
re-proves it only for the code after the guard (rejected today and after).
For q2 the span's writes `s = nil` and `s = Get()` kill the fact, so `s!!`
is a real check: no `GS0536`, accepted, prints `5` (as today, for a
different reason: section 3d).

This replaces `BackwardGotoNarrowingStates`, `BackwardGotoNarrowingState`,
`BackwardGotoNarrowingEdge`, `BackwardGotoNarrowingAccess`, the proof
generations (`narrowingProofGenerations`, `GetNarrowingProofGeneration`,
`NarrowingFrameIndices`, `NarrowingProofGenerations`),
`AssignmentNarrowingGenerations`, `AssignmentNarrowingGeneration`,
`PendingGotoAssignmentStarts`, `TrackBackwardGotoNarrowingUse`,
`AddUpstreamLabelDependencies`, `NarrowingProofDependsOn`,
`ReportUnsafeBackwardGotoNarrowings`, `GotoNarrowingSnapshot.gs` and
`CaptureGotoNarrowingSnapshot`; forward `goto` states move to
`NarrowingFlow.RecordJump` (ADR-0208 section 7), where the slice that lands
R6 puts them if it lands first. Because the #4285/#4290 suppressions
existed only to protect the stack design from jumps, whatever remains of
them after the R6 slice is deleted here.

### 12. Loops, `finally` and `catch`: what the lower bound does and does not model

- A `continue`, `break` or `goto` out of a `try` inside the body runs the
  `finally` first. Its recorded state goes through the `finally`'s exit
  transfer before the target joins it (J11, ADR-0208 section 9). For
  `continue` the join is consumed only in T3 and T6; elsewhere (1) of
  section 6 already covers the back edge.
- A `catch` inside the body is entered under `Lower(S_try, ...)` with
  `S_try ⊇ L`, and its normal exit joins the statement after the `try`
  (ADR-0208 section 9). The handler re-enters the body, so writes in the
  handler are in `R` and in the kill set (W7, nested regions), and so are
  the writes of every `when` filter of an enclosing `try`, which can run
  before the handler and whose effects the handler's normal exit carries
  to the back edge (W8, probe q14). The handler-entry rule of ADR-0208
  alone does not protect the header, which was bound before the handler.
- A throw out of the body into a handler outside the loop: the handler's
  lower bound is computed from the bound effects of the protected block,
  which include the loop's (J12).
- **Cleanup order is not modelled.** The kill set sees `x = nil` in the
  `try` and `x = "safe"` in the `finally` as two writes in the span; it
  does not know the second always runs after the first on the way to the
  jump. Probe cC therefore loses the fact at `Again` and `x.Length` reports
  `GS0158` (row R8 (a')). This is the same result the loop rule gives
  `while ... { x.Length; x = nil; x = "safe" }` (a P7 write does keep the
  fact, but only the last write in a region decides nothing: W2 counts
  every write, and the nil write kills). Modelling order would need the
  per-region CFG this ADR deletes. The maintainer decides (section 23,
  question 5); the recommendation is to accept the rejection. The fix for
  a user is `x = "safe"` before the `goto`, or a `let` copy.

### 13. Interaction with the n-ary join and `JoinTypes`

- Region exits are joins over all predecessors at once (`JoinJumps`), with
  the type rule of ADR-0208 section 6 as amended by A1 (`NarrowingState.
  JoinTypes`): `Dog` and `Animal` on `x Animal?` join to `Animal`; a
  path missing from any predecessor is dropped. A `break` carrying a
  type-test fact proven inside the body and an else-state lacking it join
  to "no fact" (q7). Three `break`s carrying `Dog`, `Cat` and `Animal`
  join to `Animal` (the g1 shape with `break` instead of `goto`; a corpus
  row pins it with the binary-fold mutant).
- The lower bound is **not** a join. `Lower` removes paths; it never
  changes a surviving fact's type. A P7 construction that keeps a
  type-test fact keeps it at its current type (the kill set either removes
  the path or leaves it). So `JoinTypes` is not consulted at region entry
  and the fallback of A1 cannot widen a fact at a loop head.
- The external-callable alias set is a fact like any other (ADR-0208
  section 8): a region that assigns the variable kills it at entry, a
  region that does not keeps it, and `ComputeLoopEntryExternalCallableAliases`
  (`StatementBinder.Jumps.gs:351`) is deleted.

### 14. Determinism

- The kill set is a set of symbols and flags; its application to a state
  removes paths from an ordered immutable array. No numbering, naming or
  metadata order is derived from it (#4663).
- Spans are computed from source positions. `JoinJumps` takes predecessors
  in source order, as today.
- The side table of section 7 is keyed by node reference and consulted for
  membership only; its iteration order is never observed.
- A function bound twice (the language server, a retry) produces the same
  states, because every input is syntax and the entry state.

### 15. Cost bounds

Per body: one syntax walk over the function's regions, bottom-up and
cached (O(function size), run only for regions entered with a non-empty
state); one span computation (O(statements) when the function has a
`goto`, zero otherwise); no lowering, no CFG, no snapshot, no second bind,
no diagnostics truncation. Expected on Core: the `narrowing.loop-rebinds`
62 second binds and the per-loop `Lowerer.Lower` + `ControlFlowGraph.Create`
disappear from the profile; the walker's cost is bounded by one traversal
of each loop body with active facts. Counters, reported in every slice's
benchmark table (ADR-0203, `GSHARP_MEASURE_PHASES`): `narrowing.region-walks`
(regions whose kill set was computed), `narrowing.region-nodes` (syntax
nodes visited by the walker, which must be at most the node count of the
walked regions), `narrowing.region-facts-killed`,
`narrowing.region-member-reads` and `narrowing.region-member-reads-with-live-facts`
(W5: member reads in regions, and those in regions entered with a live
fact on an indirect-write root),
`narrowing.spans`; `narrowing.loop-rebinds` reports 0 in L1 and is removed
in L3. Acceptance per slice is in section 20: `build/compiler-bench.py`
output parity and a `bodies` phase not worse than the baseline's range on
the Core, LanguageServer and hello-world cells.

### 16. Observable semantic changes

Each row: the shape, today's result on 0.5.212 (or on `main` after the
three soundness fixes, where stated), the result under this ADR, the
direction. "Probe" refers to the ADR-0208 corpus and to section 24.

| # | Shape | Today | After | Direction |
| --- | --- | --- | --- | --- |
| R7 (a) | A loop body reads an inherited fact before a write on an exit path: `s.Length; if c { s = nil; break }` (e2b, the `break-only` shape of `Issue2943`) | accepted | `GS0158` | less permissive (W2) |
| R7 (b) | A loop reassigns the root from a variable or a call, which the bound proof accepted: `node.Value; node = Make()` with `Make() Node` (e3); the `local` (`c = fresh`) and `function` (`c = Mk(33)`) rows of `NonNullAssignmentAfterUse_PreservesInheritedNarrowing`; `access = inner` in `ExpressionBinder.Assignments.gs:5435-5494` | accepted | `GS0158` / `GS0159` | less permissive (P7; question 1 and 4) |
| R7 (c) | A loop that contains a call reads an inherited fact on a root in the indirect-write class: q3 (an escaped closure the callee invokes; `main` compiles it and it throws) and whatever the shared predicate (A2, A3) kills for a call; the alias-class part follows the amended R12 | q3 accepted, throws; others per `main` | `GS0158` | less permissive (soundness for q3; conservative default for the rest; question 3) |
| R7 (d) | Output change in accepted programs: `x = Dog{}` keeps a type-test fact like `x = Dog()` (c8 prints `dog`, as c8b does; closes #5169); a reassignment from a variable or a call drops a type-test fact that the bound proof kept, so a hidden-member read in the loop binds on the declared type | c8 prints `animal`; the reassignment shape selects the narrowed type's member | c8 prints `dog`; the declared type's member | output change, no diagnostic (question 2) |
| R7 (e) | Every member or index read in a loop is an unknown getter (W5, no exemption) and takes the shared predicate's classification of one (`call` under ADR-0208 R14 as read today). For inherited member-bearing paths this is today's loop result (q5a, a source getter, and q5b, an imported getter, both reject `b.Pet.Name` today). The change is on plain roots in the indirect-write class: `var x C?; let clear = func() { x = nil }; if x == nil { return }; for ... { let len = sb.Length; total = total + x.Value + len }` (q5c; no call in the loop other than the getter) | q5c accepted, prints `2` | `GS0158` on `x.Value` under today's R14 reading; whatever #5231 decides for imported getters, the day it decides it | less permissive (W5 and A2; question 7; count from L0) |
| R7 (f) | The loop's exit state joins the header's false state, so a fact the condition proves on exit survives: `while s == nil { s = "ok" }; s.Length` (q12). The same fact makes a `!!` after the loop redundant: `while s == nil { s = "ok" }; s!!.Length` (q13) | q12 `GS0158`; q13 accepted, prints `2` | q12 accepted, prints `2`; q13 `GS0536` (a warning; an error where warnings are errors) | more permissive for q12; a new `GS0536` for q13 (T1 exit; I6; section 18) |
| R8 (a) | A backward-jump span reassigns the root from a variable or a call, which the deferred proof accepted | accepted | `GS0158` / `GS0159` at the read | less permissive (P7) |
| R8 (a') | The span assigns nil inside a `try` whose `finally` restores a non-null value before the jump (probe cC) | accepted, prints `4` | `GS0158` | less permissive (section 12; question 5) |
| R8 (b) | A type-test fact killed at the label makes a read bind at the declared type: `TypeTestNarrowingThroughUpcast_ReportsConversion` and `*ThroughNullableUpcast*` (valid programs) are accepted; q1 (`x.Name` where `Animal` declares `Name`) is accepted and prints `animal,animal,`; `*AtForSource*` moves from `GS0155` to `GS0116` at `x`; `*ThroughNullSafeCall*` moves from `GS0155` to `GS0159` at the same read | `GS0155`; q1 `GS0158` | accepted, or the declared type's own diagnostic | more permissive, or a changed id at the same read |
| R8 (b') | A span whose only writes are P7 values keeps the fact at the label: e15 (`s = "ab"`); a span with no write: e18/Run | `GS0158` (#4285) | accepted | more permissive (R6 of ADR-0208 extended to backward jumps) |
| R8 (c) | Every other `BackwardGoto_*` result: the deferred re-report becomes the ordinary diagnostic at the same read, with the same id, or the read binds at the declared type with no diagnostic (the `*DoesNotRequireNarrowedType`, `Inherited*`, `Hidden*Keeps*` families) | as today | same id and location | no change |
| R8 (d) | `GS0536` on an optimistic fact in a span (q2) is impossible by construction: a `!!` after a label whose span kills the fact is a real check | accepted (because of #4285) | accepted | no change; closes the hazard of section 3d |

Details per row:

- **R7 (a).** `Issue2943LoopBackEdgeNarrowingTests` `break-only` moves to
  the rejected shapes with the mutant "exempt writes followed by an exit".
  The #2943 addendum paragraph "A write on a path that exits the loop ...
  does not invalidate the body" is superseded. Compatibility: users who
  set a sentinel and `break` re-test after the loop or copy into a `let`.
- **R7 (b).** `NonNullAssignmentAfterUse_PreservesInheritedNarrowing` keeps
  its `constructor` rows and moves `local` and `function` to rejected;
  `SpeculativeRebind_*` (five tests) are deleted with the re-bind;
  `Issue2943LoopBackEdgeNarrowingEmittedOracleTests` rows are re-run.
  The #2943 paragraphs "user functions whose returns are all proven
  non-null may preserve a narrowing" and "immutable variables initialized
  from a proven-non-null value" are superseded. Bootstrap: one
  restructuring in `src/Core` (`ExpressionBinder.Assignments.gs:5435-5494`,
  read `inner` into a non-nullable `let` before the loop or test inside
  it), done in the pin-move PR, not with `!!` (ADR-0208 section 15).
- **R7 (c).** q3 joins the corpus as a run-time witness (`nre` kind today).
  c5, c6, c7, cB and `out-alias` stay rejected with their mutants (callee
  classification restored; callable arguments ignored; external alias
  exempting the by-reference class; exemption without the exact-storage
  test). Which Core sites change is L0's measurement under A3 (section 4);
  the three functions of the unamended measurement are re-checked there.
- **R7 (d).** c8 and c8b become emitted-output tests expecting `dog` for
  both (red today on c8) and are the output-parity exception of L1's
  acceptance. The comparison mode of L0 lists every hidden-member read in a
  loop whose selection changes on Core, Core.Tests and Oahu; ADR-0208's PR
  1 found two type-test reads in all of Core, neither in a loop, so the
  expected count is zero.
- **R7 (e).** q5a, q5b, q5c and q5d join the corpus; q5c carries the mutant
  "member reads are `none`" (M10), q5d the mutant "a read resolved at the
  entry scope as a field is `none`" (M24), and q5a/q5b pin today's result. The row is the
  loop face of ADR-0208 R14 and of #5231: whatever the shared predicate
  decides an unresolved getter kills in straight-line code, the loop kills
  at entry. L0 counts the member reads in regions entered with a live
  fact on an indirect-write root, and the repository and Oahu sites the
  rule rejects (question 7); an exemption, if those numbers call for one,
  is a construct-table change with the proof obligations of W5's table,
  not a rule of this ADR.
  q5c has no call other than the getter, so the mutant "member reads are
  `none`" accepts it while the rule rejects it.
- **R7 (f).** q12 joins the corpus with the M12 mutant. Today's loop exit
  keeps only the facts that were in force before the loop and never adds
  the condition's false state; the T1 exit rule is `JoinJumps` over the
  header's false state and the `break` states, which is where the gain
  comes from. The same join makes `while s == nil && Try(out s) { }`
  shapes work as users expect. Compatibility: a `!!` on the root after
  such a loop becomes redundant and reports `GS0536` (q13, accepted today),
  which is an error under this repository's warning policy; this is the
  ADR-0208 section 15 hazard for more permissive rows, and section 18
  says how the bootstrap handles it. Users outside the repository see a
  warning and delete the `!!`.
- **R8.** `Issue4519GotoAssignmentNarrowingTests` has 102 `BackwardGoto_*`
  tests; the family-by-family inventory of the ADR-0208 draft (commit
  001ee4ff5, section 16, "R8") is the re-expectation list and L2 copies it
  into its PR body with the new id for each row that changes. Outcome (a)
  has no pinning test today; L2 adds one (red on today's compiler by
  running the program: a span that reassigns from a non-null-typed variable
  and then jumps back). e15 and e18/Run flip to accepted (b'); e18/Run2,
  c3a and c3b stay rejected. Compatibility: user `goto` is rare (none in
  `src/Core`); L0 counts spans in Oahu.

### 17. Not changed

- Everything ADR-0208 section 17 lists, except the last bullet (loop and
  backward-`goto` narrowing), which this ADR replaces.
- What narrows (`SmartCastStability`), the #2442 closure rule (e14), `!!`
  not narrowing later reads (e11), `catch` and `finally` entry rules (e6,
  c1), `while x != nil` re-proving per iteration (e13), nullable
  reassignment in a loop (e4), shadowing (e16), aliased storage in a loop
  (`out-alias`), the forward-jump and write-returns-through-another-label
  counterexamples (c3a, c3b), a local callable shadowing a type (d2), dead
  code and non-completing `finally` adding no edges (d6), f4, f5.
- The construct table's classes. This ADR adds no class; W5 is the `call`
  class applied where binding information is absent.
- ADR-0069 stays the semantics reference for what narrows; the #2943
  addendum's loop paragraphs named in section 16 are superseded by this ADR
  and the pin-move PR updates them with pointers.
- Definite assignment and definite return (`ControlFlowGraph.AllPathsReturn`)
  are untouched; #5142's shared CFG is not a prerequisite and, if it lands,
  the walker may read a loop's assigned roots from it without changing a
  result.
- The language server reads `NarrowedType` from the bound tree (ADR-0208
  section 14); nothing here changes that.

### 18. Bootstrap and N-1

The implementation is ordinary source under the pinned compiler; the new
rules meet the repository's own source at the next pin move. Known
restructurings in `src/Core`, each a restructuring and never `!!` (ADR-0208
section 15: under the pin, `!!` on a proven value is `GS0536` and warnings
are errors):

- R7 (b): `ExpressionBinder.Assignments.gs:5435-5494` (`access = inner`).
- R7 (c): to be re-measured in L0 under A3; the unamended measurement named
  `BinderContext.gs:906-923`, `MemberLookup.gs:1108-1120` and
  `:3100-3172`. The two `MemberLookup` sites read closure-assigned locals in
  loops that call; under A2 the straight-line rule of #5130 already rejects
  the same reads after a call, so they may be the join slices' cost rather
  than this ADR's.
- R7 (e): count from L0.
- R8: none (`src/Core` has no user `goto`).

More permissive rows make some `!!` in repository source redundant
(`GS0536`, ADR-0208 section 15): R8 (b) and (b') touch none, because
`src/Core` has no `goto`, but R7 (f) can touch any `!!` on a root after a
loop whose condition proves it (q13). Nothing can be removed before the
pin move, because the pinned compiler still needs them. L0's `.loops`
report lists every read after a loop exit whose new fact makes a `!!`
redundant on Core, Core.Tests, gsc and Oahu; L1's PR body carries that
list for the pin-move PR, which removes them. Every slice compiles Core, Core.Tests and gsc with the built
compiler (the response-file procedure of ADR-0208's References section)
and lists the diagnostics outside its rows; a diagnostic outside the rows
blocks the slice.

### 19. Soundness invariants and the rows that pin them

Each invariant names the rule it follows from, the corpus rows that pin it
and the mutant that must turn them red (ADR-0154). "Row" means a row of
`Adr0208NarrowingCorpusTests` (existing or added by this ADR: q1 to q9 in
section 24) or a named test.

| # | Invariant | Rows | Mutant |
| --- | --- | --- | --- |
| I1 | Region closure: every effect the walker finds in `R`, and every enclosing-filter write a `catch` in `R` can carry back (W8), is applied to `S` before `R` is bound, so every fact of `L` holds everywhere in `R` and on the back edge | q14, e4, f4, e2b (after), e3 (after), d3 loop form, d4 loop form, `out-alias`, c5, c6, c7, cB, q3, q9 | exempt writes followed by `break`/`return` (e2b accepted); treat a call as `none` (q3, c5, c6, cB accepted); treat `out`/`ref` arguments as reads (`out-alias` accepted) |
| I2 | Entry completeness: `S` joins every edge into `R` from outside, forward `goto`s into labels inside `R` included | c3a, q6 (a forward `goto` into a `while` body past the guard; rejected today and after) | build `S` from the fall-in state only (c3a accepted; q6 accepted and the header dereferences nil at run time) |
| I3 | Scope-aware names: a region-local declaration does not kill the outer variable; an unrecognised declaration kills | e16, q4 (a loop body's `let s` shadowing the narrowed `s` with a guard inside; accepted) | resolve names without the declaration stack (e16 rejected) |
| I4 | Closed kind list: an unlisted syntax kind empties the region's entry state (W6; stronger than `call`, which keeps plain locals) | the `SyntaxKind` enumeration test, and a walker unit test that an unlisted kind yields `ContainsUnknownKind` and `L = Empty` | class an unlisted kind `none` or `call` (both red) |
| I5 | P7 exact storage and reference-type construction only | `out-alias`, f4, d2, c8/c8b (`dog` for both), `NonNullAssignmentToDifferentSubtype_InvalidatesTypeNarrowing`, e3 (rejected after) | accept any construction (f4 accepted); accept a `ref` target (`out-alias` accepted); accept a call (e3 accepted) |
| I6 | Header bound once under `L`; exit = `Jmp(break, header-false)`, never the entry state | e13, q7, q8, q12, g1-with-`break` row | bind the header under `S` (a new row: `while s.Length > 0 { s = Get() }` with `s` nullable, accepted under the mutant, rejected after); join the entry state into the exit (q12 rejected: `while s == nil { s = "ok" }; s.Length` gains the fact from the header-false state and the fact-free entry would remove it; q7 cannot distinguish this mutant because its header-false state already lacks the fact) |
| I7 | Cleanup transfers on jumps out of regions; cleanup order not modelled | `GotoLeavingTry_*`, `*Finally*` rows of `Issue4519`, cC (rejected after) | skip the `finally` exit transfer on `break` states (a `finally` that assigns nil before a `break` is accepted) |
| I8 | Reachability: dead jumps record no edge, a jump that leaves a non-completing `finally` records no edge, a jump inside the same `try` is live, a label without a reachable edge is bound under the facts in force | d6, q10, `Unreachable{Forward,Backward}Goto_DoesNotInvalidateReachableNarrowing` | count a `goto` through a non-completing `finally` as a participant (d6 rejected: conservative, so the mutant turns the row red by changing an accepted result); exclude a `goto` inside the `try` (q10 accepted and dereferences nil, M21) |
| I9 | Span covers every label from the earliest backward target through the last participant `goto`, and is bound from `L` at its first statement | c3a, c3b, e15, e18, q9, q11 | shrink the span to label-through-its-own-`goto` (c3b accepted); exclude labels that are not backward targets from participation (c3a accepted); bind only the labels from `L` (q11 accepted, M22) |
| I10 | Determinism: no result depends on iteration order | the existing byte-identity harness (two compiles of Core compared) | none (structural) |
| I11 | No optimistic fact: a `!!` or a type-test read after a label is bound at the label's `L` | q2 (accepted, no `GS0536`), q1 (accepted, prints `animal,animal,`) | bind the label under `S` with the deferred checker removed (q2 reports `GS0536`; q1 binds `Dog.Name` with a `castclass` and throws `InvalidCastException` on the second iteration) |

Rows that **cannot** carry a mutant witness are listed as such: I8's
"when the walker cannot tell, the `goto` counts" has no accepted program
that distinguishes it (the conservative branch only rejects more), so the
row for it is a negative test on the walker's output (a unit test of
`RegionEffectScanner` that asserts the `goto` is counted), not a program.

### 20. Implementation plan: four independently shippable slices

Each slice: narrowing conformance suite green except the rows it lands;
every new or changed behavioural test carries an ADR-0154 witness (red on
the pre-change compiler or under a named mutant of section 19 or 21);
byte-identical implementation, reference, PDB and XML output and identical
diagnostics on Core, Core.Tests, gsc and the pinned Oahu inputs except
where the slice's rows predict a change, each listed in the PR body; the
compiler-bench table (`build/compiler-bench.py`, Core, LanguageServer and
hello-world cells, `GSHARP_MEASURE_PHASES` phases and the section 15
counters, 4 interleaved runs or more) with `bodies` inside the baseline's
range or better; `GSHARP_NARROWING_PARITY=1` on for the test runs while
the frame projection exists (A1); a compile of Core, Core.Tests and gsc
with the built compiler with zero diagnostics outside the landed rows; a
release-notes entry under Unreleased; the ADR-0208 corpus document
updated with the rows the slice adds or flips. No slice enables
auto-merge. Each slice is sized for one coding agent and names what it
does **not** do.

**L0. The walker and the loop comparison mode (no behaviour change).**
`RegionEffectScanner` with rules W1 to W7, the per-body side table, the
`SyntaxKind` enumeration test, and the span computation of section 11
(computed, not consumed). A loop comparison mode under the existing
`GSHARP_NARROWING_COMPARE=<path>` (a third report, `.loops`): at every
loop whose entry state is non-empty, compute `Lower(S, R)` from the walker
and compare, fact by fact, with what today's bound back-edge analysis
removes after the first bind; write every disagreement as `file:line,
path, kept-by-old/killed-by-new or the reverse, rule (W1..W7, P7), row
(R7 a-e)`; and at every span, the kill set and the labels. Counters of
section 15. Deliverables in the PR body: the disagreement table for Core,
Core.Tests, gsc and the 12 Oahu projects by row; the W5 counts (member
reads in regions entered with a live fact on an indirect-write root, and
the sites R7 (e) rejects); the re-measurement of R7 (c) under A3; the number of spans in
Oahu; the list of repository sites each of R7 (a), (b), (c), (e) would
reject. Acceptance: byte-identical output; every disagreement falls under a
row of section 16 (a disagreement outside the table is a defect of this
ADR, amended before L1); the enumeration test red under the "unlisted kind
is `none`" mutant. User-visible changes: none. Does not: change any state,
delete anything, touch the backward-`goto` checker. Prerequisite: none (it
adds files and one hook in `BindLoopBody`); it may land in parallel with
#5247.

**L1. Loops: kill at entry, bind once (R7 (a) to (e)).** `BindLoopBody`
computes `L` from the walker, applies it to the entry state (and to the
frames through `InvalidateInheritedNarrowings` while they exist, A1), binds
the header and body once per table 9, and joins the exit per table 9.
Deletes: the snapshot and restore (`:287-319`, `:376-422`),
`Diagnostics.TruncateTo` at that site, `NarrowingComparison.BeginSpeculation`/
`EndSpeculation`, `CollectLoopBackEdgeMutations` and its per-loop
`Lowerer.Lower` and `ControlFlowGraph.Create`, `LoopBackEdgeMutationCollector`,
`CollectInheritedNarrowingInvalidations`, `ComputeLoopEntryExternalCallableAliases`,
`AssignmentPreservesNarrowing`, `IsDefinitelyNonNullValue`,
`FunctionReturnsDefinitelyNonNull`, `IsDefinitelyNonNullSyntax`, the
`bindIteration` second-bind callbacks of `StatementBinder.Loops.gs:634,
732, 958` (the header is bound once, before the body, under `L`), the
`iterationRunsUserCode` flag (the walker's T5 class replaces it), and the
`SpeculativeRebind_*` tests. Tests: section 16 R7 inventory; q3, q4, q5,
q7, q8, q9 and the I6 header row join the corpus with their witnesses; c8
and c8b become emitted-output tests; the `Issue2943` re-expectations.
Acceptance: the L0 comparison report's disagreements all fall under R7;
`narrowing.loop-rebinds` reports 0; no `Lowerer.Lower` or
`ControlFlowGraph.Create` frame under `BindLoopBody` in the profile; the
bootstrap list of section 18 confirmed by the response-file compile.
User-visible changes: new rejects e2b (`s.Length; if c { s = nil; break
}`), e3 (`node = Make()`), the `local` and `function` rows of
`NonNullAssignmentAfterUse_PreservesInheritedNarrowing`, q3 (an escaped
closure the callee invokes; a crash today), q5c (a member read as a call
for an indirect-write root), and the Core `access = inner` site; new
accepts: q12 (`while s == nil { s = "ok" }; s.Length`, R7 (f)); output
change: c8 prints `dog` (as c8b); new `GS0536` on a `!!` that the loop
exit's new fact makes redundant (q13; the repository sites go to the
pin-move PR, section 18); no diagnostic id changes at a rejected read. Does not: touch spans or the backward-`goto` checker (the loop snapshot's
clone of `BackwardGotoNarrowingStates` goes with the snapshot; the checker
still reads the live structure). Prerequisite: L0's report; #5130's slice
that deletes the frame stack is recommended first so L1 does not have to
maintain the frame kill alongside the state kill (if L1 lands before it,
A1 applies and the parity assertion gates it).

**L2. Backward jumps: the span rule (R8 (a) to (d)).** Spans consumed:
`DefineUserLabel` binds a participant label under `Lower(S, span)`;
`BindGotoStatement` records forward states through `NarrowingFlow.RecordJump`
(or the structure the R6 slice introduced) and records nothing for a
participant `goto`; reachability per section 11. Deletes the list of
section 11 (`GotoNarrowingSnapshot.gs`, the `BackwardGoto*` types,
`TrackBackwardGotoNarrowingUse` and its call sites in `ExpressionBinder`
and `MemberLookup`, the proof generations, `ReportUnsafeBackwardGotoNarrowings`,
`ActivateDeferredReachableGotoEdges`, `DeferredUnreachableGotoEdges`,
`ReachableUserLabels`, `PotentialReachabilityLabel`, `AddUpstreamLabelDependencies`,
`NarrowingProofDependsOn`, `FinalizeNestedUserLabelNarrowings`'s body, the
`LambdaBinder` save and restore) and the remaining #4285/#4290 code.
Tests: the 102 `BackwardGoto_*` re-expectations per the draft's inventory
with the new id recorded per row; a new test for R8 (a) with a run-time
witness; q1, q2, q6, q10 and q11 join the corpus; e15 and e18 flip; cC flips to
rejected (question 5). Acceptance: the span count and label list from L0
match on Oahu; output identity except the listed rows. User-visible
changes: new rejects cC (`x = nil` in a `try` whose `finally` restores
before `goto Again`) and the R8 (a) shape (a span that reassigns from a
variable or a call); new accepts e15 (`again: ... s = "ab"; goto again`),
e18/Run (a span without writes), q1 (`x.Name` on `Animal` after the span
kills `Dog`), `TypeTestNarrowingThroughUpcast_ReportsConversion` and
`*ThroughNullableUpcast*`; id changes at the same read: `*AtForSource*`
(`GS0155` to `GS0116`), `*ThroughNullSafeCall*` (`GS0155` to `GS0159`).
**Ordering with
#5130:** L2 lands before the slice that removes the #4285/#4290
suppressions, or that slice keeps the suppression inside backward-jump
spans (a syntactic test the L0 walker already provides) until L2 lands;
q2 is the row that goes red if the order is wrong (section 3d). Does not:
touch loops beyond the shared walker. Prerequisite: L0.

**L3. Cleanup.** Delete `AssignedRootsCollector` if the join slices left
it only for the loop collector (ADR-0208 PR 4 names it); delete the loop
comparison report and the `.loops` mode; remove `narrowing.loop-rebinds`;
update ADR-0069's #2943 addendum paragraphs with pointers to this ADR;
update `website/docs/ref/spec.md` "Smart casts (flow narrowing)" (the
loop and `goto` paragraphs), `website/docs/tour/control-flow.md`, and the
ADR-0208 corpus document's "Experiments" section with the final table;
release notes. Acceptance: `StatementBinder.Narrowing.gs` reduced to the
classifiers, the transfer functions and the walker; `StatementBinder.Jumps.gs`
without snapshot code; full suite green; the benchmark table.

The order is L0, L1, L2, L3. L1 and L2 may be developed in parallel
branches after L0 (they share the walker only), but L2's ordering
constraint with #5130 is the binding one.

### 20a. Findings of slice L0

Slice L0 (PR [#5342](https://github.com/DavidObando/gsharp/pull/5342)) measured
the walker against today's back-edge analysis with `GSHARP_NARROWING_COMPARE`
(`.loops` report) on every project of the repository and on the pinned Oahu
inputs. No disagreement falls outside the rows of section 16, and the walker
never keeps a fact that today's analysis removes except the construction forms
of row R7 (d) (none in any measured code).

**Divergences from the text above.**

- *A3.* The slice implements the merged amendment (#5298), a simple rule, not
  the operand-type reachability test that section 7 describes. A call to a
  named function or a method keeps the fact of a by-reference parameter; user
  code that the table lists (an indirect or construction call, a loop header
  that iterates, `await`, and every member read under W5) keeps the full
  alias-class kill. The `Calls` entries therefore carry the callee shape and
  the `ref`/`out` and by-value names of each call (to find a variable that one
  call passes twice), and no operand types. A member call is treated as a plain
  call, because the walker cannot tell a method from a function-typed field.
- *Operators.* A user-defined operator or conversion is not a call here: the
  walker only sets `ContainsOperatorCandidate`, as the effective straight-line
  predicate does not treat them as calls either. The decision is open for L1.
- *W8.* The consumer uses the `when` filters of the enclosing `try` statements
  (the helper that ADR-0208 R10 already has), not a function-wide set.
- *Cache.* A loop's record is cached per loop, shared between the nested and
  the top-level form when no part of the loop runs once.

**Measurements** (facts of the loops that inherit a fact; "killed" and "kept"
are by both analyses):

| Input | Loops with live facts | Facts | Both kill | Both keep | old keeps, walker kills | old kills, walker keeps | Spans |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Core | 1466 | 2037 | 48 | 1973 | 16 (R7 a 1, b 2, c 12, e 1) | 0 | 0 |
| Core.Tests | 28 | 30 | 0 | 30 | 0 | 0 | 0 |
| gsc (Compiler) | 3 | 3 | 0 | 3 | 0 | 0 | 0 |
| Oahu, 12 cells that compile | 55 | 68 | 7 | 61 | 0 | 0 | 0 |
| Cs2Gs.Translator | 336 | 432 | 5 | 422 | 5 (R7 b 1, c 3, e 1) | 0 | 0 |
| All other repository projects | 447 | 515 | 5 | 510 | 0 | 0 | 0 |

The Oahu cells `Oahu` (App) and `Oahu.UI` need generated sources that the
pinned inputs lack, and `Oahu.Cli.Tests` has stale inputs, so they were not
measured. The 7 loops that both analyses kill on Oahu are the 7 second binds
of section 2.

**Sites.** R7 (a): `ConversionClassifier.gs:2049`. R7 (b): `Binder.gs:5300`
(`current = next`), `ExpressionBinder.Assignments.gs:5440` (`access = inner`,
a pattern variable) and `CSharpToGSharpTranslator.Deconstruction.gs:111`.
R7 (c), re-measured under the merged A3: twelve facts in seven loops of
`MemberLookup.gs` (1096, 1111, 3100, 3115, 3144, 3165) and
`ClrTypeUtilities.gs:1346`, all closure-assigned locals that a call can reach
(no by-reference parameter is killed by a plain call; `BinderContext.gs:906-923`
of the unamended measurement is kept), and three in
`CSharpToGSharpTranslator.Invocations.gs` (4543, 4554, 4562). R7 (e): one
member path in `CustomAttributeEncoder.gs:1477` and one in
`CSharpToGSharpTranslator.Expressions.gs:6481`. These are facts killed at loop
entry, not errors; the errors are L1's measurement.

**Question 4.** Pattern-bound names on the right of a loop write: one site in
Core (`access = inner`), none in Oahu. Under the provisional rule, L1 does not
add the clause for Oahu's sake.

**Question 7.** Under the strict W5 rule the walker kills one fact at loop entry
that today's analysis keeps because of a member read (`CustomAttributeEncoder.gs:1477`,
a member path) in Core, one in Cs2Gs.Translator and none in Oahu. Core has 7017
member reads in loops, 2420 of them in regions entered with a live fact on an
indirect-write root. These numbers do not call for an exemption.

**R7 (f) and `!!`.** The header of a `while`, `for` or `do` loop proves a new
fact on exit at 3 loops in Core, 2 in Oahu and 2 elsewhere. No `!!` on that
root follows any of them in its function, so the pin-move PR has no `!!` to
remove for R7 (f) on the measured code.

**Spans.** Core, Core.Tests, gsc and the Oahu cells that compile have no
backward `goto`, so no span.

### 20b. Findings of slice L1

Slice L1 (issue [#5317](https://github.com/DavidObando/gsharp/issues/5317), which also
closes [#5315](https://github.com/DavidObando/gsharp/issues/5315)) replaced the snapshot and
the second bind of `BindLoopBody` with the lower bound of section 6, applied to the frames
before the header and the body are bound once. Each loop that is entered with a fact in force
runs `ApplyLoopEntryLowerBound`; the decisions are those of slice L0 (`DecideRegionKill`).

**Divergences from the text above.**

- *Deletions.* `CollectLoopBackEdgeMutations`, `LoopBackEdgeMutationCollector`,
  `CollectInheritedNarrowingInvalidations`, `ComputeLoopEntryExternalCallableAliases`,
  `MarkIterationRunsUserCode`, `NarrowingComparison.BeginSpeculation`/`EndSpeculation`, the
  `inheritedNarrowingFrameCount`, `backEdgeTail` and `backEdgeCondition` parameters and the
  `bindIteration` tuple are gone. `AssignmentPreservesNarrowing`, `IsDefinitelyNonNullValue`,
  `FunctionReturnsDefinitelyNonNull` and `IsDefinitelyNonNullSyntax` stay: the `finally` summaries
  and the backward-`goto` checker still call them, and L2 deletes them with the checker.
  `narrowing.loop-rebinds` is no longer counted (it reads 0; L3 removes the name).
- *Iteration.* `iterationRunsUserCode` stays, as an argument of `BindLoopBody` and of
  `RegionEffectScanner.ScanLoop`: whether a `for ... in` header runs user code is a property of the
  collection's type, which syntax does not show. An array, a slice or a string iteration is not a
  call (the `indexed-for-in` row of #5170 keeps its result). A nested loop is still a call.
- *Literal types.* A non-nil literal proves a type-test fact only when it is a string literal whose type
  converts to the fact's type. Slice L0 took every literal for a string, so `value = 42` kept a
  `value is string` fact.
- *Member reads and by-reference parameters.* A member read keeps member-bearing paths, mutable
  globals, closure-assigned locals and the facts of an alias of an element or a member out
  (W5, no exemption). It does not remove the fact of a by-reference parameter, as a plain call does not
  (amendment A3, #5292); only a member, index or pointer write, an indirect call, an iteration or a
  suspension does. Slice L0 removed it on any read, which rejected the A3 rows `h1`,
  `out-parameter-survives-calls-in-a-loop` and `out-parameters-of-different-types-do-not-overlap`.
- *No back edge.* A loop whose condition is the literal `false` (`while false`, `do { } while false`)
  is bound under its entry state.
- *Closure-assigned names.* They are computed on first use. `ApplyLoopEntryLowerBound` computes them
  before it decides, because until then the shared predicate assumes that every name is assigned.
- *Exit state (R7 (f)).* Break states are not recorded, so the join of table 9 cannot be taken. A loop
  without a `break` in its body, in a function without a user label, adds the facts of the header's false
  state to the block after the loop, minus the facts that the condition itself can remove
  (`RecordLoopExitFacts`). A loop with a `break` keeps today's exit. The row `g1`-with-`break` and the
  join of break states wait for the slice that records them.
- *External callable aliases.* A function value that the region assigns, or that shares storage with one
  that it assigns, leaves the set at the loop entry; a region with a pointer write or an unknown syntax
  kind empties the set.
- *R16 in loops (documented cost of row R7 (e)).* ADR-0208 R16 keeps a fact across a read of a stable imported
  getter (`string.Length`) and a field read is no call, in straight-line code. The walker sees only syntax, so it
  cannot tell them from a user getter, and Q7 (decided) allows no exemption: the corpus row
  `t09_5231_string_length_in_a_loop_R16_loop_is_stricter` (`x.Value + s.Length` with a closure-assigned `x`) is
  rejected in a loop. A resolved-member exemption (a plain-name receiver resolved at the entry scope whose member is
  on the R16 list, or a field of a class whose hierarchy cannot hide it) is a later slice; it would accept q5c, q5d
  would stay rejected, and it needs its own rows and mutants.
- *A loop the walker cannot name* (the synthetic loop of a collection spread) removes every fact.

**Measurements** (candidate compiler, the cells of slice L0, compare mode on). Facts of the loops that
inherit a fact; "removed" is the walker's decision, which the binder now applies.

| Input | Loops with live facts | Facts | Removed | Kept | Compile of the cell |
| --- | --- | --- | --- | --- | --- |
| Core | 1494 | 2089 | 59 | 2030 | 33 errors, listed below |
| Core.Tests | 30 | 32 | 0 | 32 | clean |
| gsc | 4 | 4 | 0 | 4 | clean |
| Oahu, 12 cells that compile | 50 | 63 | 6 | 57 | clean (`Oahu.Cli.Tui` has the same 8 errors with the main compiler) |
| Cs2Gs.Translator | 335 | 431 | 9 | 422 | 4 errors at one site |

The 33 errors of Core are the sites of rows R7 (b) and R7 (c): `ExpressionBinder.Assignments.gs:5452-5501`
(`access = inner`, a pattern variable; question 4), and `MemberLookup.gs:1213` with `3319-3379` (a
closure-assigned local read in a loop that calls). Cs2Gs.Translator has `Deconstruction.gs:111-125`
(a reassignment from a pattern variable). No diagnostic falls outside a row of
section 16. The pin-move PR restructures these sites (section 18).

### 21. Mutation-evidence plan (ADR-0154)

Each rule has a named, hand-applied mutant that is run red and then
reverted; the slice's PR body lists the mutant and the rows it turned red:

| Mutant | Rule | Red rows |
| --- | --- | --- |
| M1 exit-path exemption restored (writes followed by `break`/`return`/`throw`/`goto` skipped) | W2 | e2b (expected rejected) |
| M2 declaration stack removed | W1 | e16, q4 |
| M3 unlisted syntax kind classed `none` | W6 | the enumeration test |
| M4 construction proof accepts value types | P7 | f4 |
| M5 construction proof accepts `T(...)` only | P7 | c8 (`dog` expected) |
| M6 proof accepts a call with non-nullable return | P7 / question 1 | e3 (expected rejected) |
| M7 proof accepts a `ref` or `out` target | P7 | `out-alias` |
| M8 call classed `none` for closure-assigned roots | W4 | q3, c5, c6, cB |
| M9 call classed `none` for the alias class (within what A3 keeps) | W4 / A2 | c7, d4 loop form, g2 loop form |
| M10 member read classed `none` | W5 | q5, #5231 loop form |
| M11 header bound under `S` | T1 | the I6 header row |
| M12 entry state joined into the exit | T1 exit | q12 (accepted after; the mutant rejects it) |
| M21 `goto` inside a `try` excluded because the `finally` ends in `return` | section 11 participants | q10 |
| M22 span bound from `L` at its labels only, not at its first statement | section 11 span entry | q11 (the header read is accepted under the mutant and dereferences nil) |
| M23 shared predicate consulted after P7 (steps (ii) to (iv) after (vi)) | section 7 consumer rule | d4 loop form, f2 loop form, a `b = Box{}` row after a guard on `b.Pet` |
| M24 a member read resolved at the entry scope as a field or auto property classed `none` | W5 | q5d (`x.Value` read first, then `if b is Derived { let c = b.Count }`, two iterations; `Base.Count` is a field and `Derived.Count` a getter with a body that clears `x`; the stale fact is reached through the back edge, not caught by the straight-line kill after the getter; accepted under the mutant and dereferences nil) |
| M27 filter write set omitted from a region that contains a `catch` | W8 | q14 (accepted under the mutant; the header dereferences nil after the inner handler resumes the loop) |
| M26 `MayShareStorage(r, r)` applied to the identical root in step (iv) | section 7 consumer rule | e15, c8 (`dog`), the `constructor` rows of `NonNullAssignmentAfterUse_PreservesInheritedNarrowing` (all rejected under the mutant) |
| M13 `do` body bound under `S` | T6 | q8 |
| M14 span shrunk to label-through-own-`goto` | section 11 | c3b |
| M15 non-target labels excluded from participation | section 11 | c3a |
| M16 forward `goto` states omitted from `S` | section 6 / 11 | c3a, q6 |
| M17 dead `goto` counted as participant | J8 | d6 (its accepted result changes) |
| M18 `finally` exit transfer skipped on `break` states | J11 | the I7 row |
| M19 binary fold instead of n-ary join at `break` | section 13 | g1-with-`break` row |
| M20 participant label bound under `S` (optimism restored) | section 11 | q1, q2 |

### 22. Risks

- **The walker misses a write form** (a new assignment syntax, a
  deconstruction, a compound operator, an `out var` in a nested
  expression). Unsound direction. Mitigation: W6 and the enumeration test;
  L0's comparison against the bound collector on four code bases before
  anything changes; a disagreement "old kills, new keeps" blocks L1.
- **A rule not derived from the invariant.** Mitigation as ADR-0208
  section 20: every entry-state rule here is an instance of `Lower`, every
  exit is a `JoinJumps`, and section 19 pins each with a mutant. A review
  that finds a rule not derivable from the invariant blocks the slice.
- **Cost of the conservative default on real code** (R7 (c), (e)).
  Mitigation: L0 measures on Core, Core.Tests, gsc and Oahu before L1; if
  R7 (e) costs sites, W5's table lists what a construct-table exemption
  would have to prove; the maintainer sees the numbers before L1 lands.
- **Ordering with #5130.** Section 3d. Mitigation: the ordering statement in
  L2 and row q2.
- **Walker cost in bodies with many loops.** Mitigation: per-node caching
  and the non-empty-entry guard; the benchmark gates each slice; the
  counters show node visits against node counts.
- **A forward jump into a loop body** (q6) has no test today and is masked
  by #4285. Mitigation: q6 joins the corpus in L1 with the M16 mutant;
  #5301 (section 3d) asks the R6 slice to join the jump into the loop's
  entry state under the mechanism it keeps.

### 23. Decided questions

The maintainer accepted this ADR on 2026-10-24 and decided each question
below as recommended, so every recommendation is a decision. The one
marked *provisional* (question 4) is decided as recommended too: its
default stands unless slice L0's numbers meet the stated condition, in
which case the stated alternative applies without a further decision.
Question 7's recommendation was narrowed by review round 4 of PR #5302
(no exemption at all in this ADR); its text says so. Questions 1 to 3
are ADR-0208's deferred questions 4, 7 and 6. The slice named with each
question is the one that first depends on it.

1. **(ADR-0208 Q4) Should a call to a function whose declared return type
   is non-nullable count as a non-null proof across a back edge?** Today's
   `FunctionReturnsDefinitelyNonNull` reads the callee's body syntax; the
   #2943 addendum rejected static non-nullability as proof because a
   caller can pass a runtime nil through a statically non-null field, and
   under ADR-0186 platform types a non-null declared type is a weaker
   claim still. Recommendation: **no**; delete the cross-function proof;
   e3 flips to rejected (R7 (b)); the fix is a re-test in the loop or a
   non-nullable loop variable. Revisit with #4363 if the nullability query
   API ever gives a sound "this call cannot return nil". L1.
2. **(ADR-0208 Q6) R7 (d): when a loop drops a type-test fact because the
   body reassigns from a variable or a call, a hidden-member read in the
   body selects the declared type's member, with no diagnostic. Accept as
   documented, add a warning, or widen P7?** Recommendation: **accept as
   documented**; L0's comparison mode lists every such site on Core,
   Core.Tests and Oahu (expected zero: ADR-0208's PR 1 found two type-test
   reads in all of Core, neither in a loop); member hiding plus
   reassignment inside a narrowed loop is rare, and a warning would need a
   new diagnostic for a shape the join slices already change without one
   (R1 (b)). L1.
3. **(ADR-0208 Q7) Should the walker exempt calls whose callee is a
   `static`/top-level function name with no callable-typed argument?**
   Recommendation: **no**. Probe q3 is a top-level callee with no callable
   argument that invokes an escaped closure; the exemption is unsound, not
   just imprecise, and A2 means the loop rule inherits whatever the
   straight-line rule decides for calls, so a loop-only exemption would be
   a second definition. The measured cost is re-taken in L0 under A3. L1.
4. **Should P7 accept a right side that is a name resolving (at the
   region's entry scope) to a pattern-bound variable of the function
   (`is T name`, `if let`/`guard let`/`while let` binding, a `case T name`
   arm)?** Such a variable is immutable and non-null by the construct that
   bound it, and it is the one Core site R7 (b) rejects (`access = inner`).
   **Decided for slice L1 (maintainer, 2026-10-30): add the clause.** The reason is the nightly's
   `gsharp-csharp` leg, not Oahu: its frozen C# corpus translates to the same `access = inner` shape in Core
   (`ExpressionBinder.Assignments.gs`) and in `Cs2Gs.Translator` (`CSharpToGSharpTranslator.Deconstruction.gs`),
   and no restructuring of `src/Core` reaches that corpus, so without the clause 24 of the 58 apps went red.
   The clause: a loop write whose right side is a pattern-bound variable (a `TypePattern` with a plain type
   name, or an entry-scope variable declared by a `TypePattern`, `VarPattern` or `if let`/`guard let`/`while let`
   binding) is a P7 proof when its type converts to the root's declared type (and to the fact's type for a
   type-test fact) by `Conversion.IsRepresentationPreservingImplicit`, so no conversion operator runs. A
   pattern variable that the region declares with a pattern the walker cannot type (`var`, `if let`) is still no
   proof. An ordinary `let` or `var` copy is no proof. Original recommendation, superseded:
   **not in L1**, *provisional*: the site costs one `let`
   copy; L0 reports how many such sites Oahu has; if L0 finds any, L1 adds
   the clause (the symbol must record that it was bound by a non-null
   producing pattern, which the slice confirms or adds) with a corpus row
   and the mutant "accept any `let`". L1.
5. **R8 (a'): should cC stay accepted?** Keeping it needs the per-region
   CFG to know that the `finally`'s write is the last on the way to the
   jump. Recommendation: **accept the rejection**; the shape is a nil
   write undone by cleanup before a backward jump, the fix is a non-null
   write before the `goto`, and `src/Core` has no `goto`. L2.
6. **Should W2 keep a syntactic exit-write exemption** (an assignment
   statement directly followed in the same statement list by an
   unconditional `break` or `return`, outside any `try` inside the loop)?
   Recommendation: **no**. Measured as load-bearing in zero functions of
   Core, Core.Tests and gsc; every exception to "every write counts" is a
   place where a `throw` caught inside the loop, a `defer`, or a label
   between the write and the exit reintroduces the back edge; the user's
   fix is a re-test after the loop. L1.
7. **W5: should the walker exempt any member read from the unknown-getter
   classification (a field, an auto property, an array element resolved at
   the region's entry scope)?** Recommendation: **no exemption in this
   ADR**; every member read in a region is an unknown getter and takes the
   shared predicate's classification. Three review rounds on an exemption
   each found a case where the member selected inside the region (after a
   type-test fact) is not the member found at the entry scope (hiding by a
   computed property, `open` auto properties, G# `sealed` admitting
   same-assembly subclasses); W5's table records them as the proof
   obligations any future exemption carries. L0 counts what the strict
   rule costs; if it rejects repository or Oahu sites, an exemption is a
   construct-table change under ADR-0208 section 8 with its own corpus
   rows, applied to the straight-line read too, and approved on its own.
   Decided: as recommended (the earlier recommendation, a resolved variant
   gated on L0's numbers, is withdrawn by review round 4). L1.
8. **Ordering with #5130's R6 slice** (section 3d): land L2 first, or have
   that slice keep the #4285 suppression inside backward-jump spans until
   L2? Recommendation: **land L2 before the R6 slice** if L0 and L2 fit the
   schedule; otherwise the span-scoped suppression, which L0's span
   computation makes a one-predicate change, with q2 as the guard row.
   The same slice must join a forward `goto` into a loop body into the
   loop's entry (q6, section 3d) whichever order is chosen. L2.
9. **Should the `continue` label's join be recorded in T1/T2/T4/T5/T7
   where nothing consumes it**, for a future per-position query (ADR-0208
   section 14, decided question 5: states for `SemanticModel` wait for a
   consumer)? Recommendation: **no**; record it when a consumer exists. L1.

### 24. Probe sources added by this ADR

Each row below is a corpus row (`Adr0208NarrowingCorpusTests`) once its
slice lands; the "0.5.212" column is the pinned compiler's result,
measured for this ADR; the sources are in the References section.

| Probe | Shape | 0.5.212 | After |
| --- | --- | --- | --- |
| q1 | `x Animal = Dog{}`; hiding `Name` on `Animal` and `Dog`; `if x is Dog { Again: last = last + x.Name + ","; x = Animal{}; i++; if i < n { goto Again } }` | `GS0158` on `x.Name` (the deferred checker re-reports a member that `Animal` has) | accepted, prints `animal,animal,`: the span's write kills `x -> Dog`, the read binds on `Animal` (R8 (b)) |
| q2 | guard; `Again: i = i + s!!.Length; s = nil; if i < n { s = Get(); goto Again }` | accepted (no `GS0536`, because of #4285), prints `5` | accepted, prints `5` (R8 (d)); under the R6 slice without L2: `GS0536` |
| q3 | `var x C? = C{}; let h = Holder{}; h.Callback = func() { x = nil }; if x == nil { return 0 }; for ... { total += x.Value; Wrapper(h) }` where `Wrapper(h Holder) { h.Callback() }` | accepted; throws `NullReferenceException` | `GS0158` on `x.Value` (R7 (c)) |
| q4 | guard on `s`; loop body `let s string? = Get(); if s == nil { continue }; Consume(s.Length)`; after the loop `s.Length` | accepted, prints `3` | accepted, prints `3` (W1) |
| q5a | `if b.Pet == nil { return }`; loop body `Consume(x.Count); b.Pet.Name.Length` where `Count` is a source getter with a body | `GS0158` on `b.Pet.Name` | `GS0158` (R7 (e), no change) |
| q5b | as q5a with `sb.Length` on a `StringBuilder` (an imported getter) | `GS0158` on `b.Pet.Name` | `GS0158` (R7 (e), no change) |
| q5c | `var x C?; let clear = func() { x = nil }; if x == nil { return }; for ... { let len = sb.Length; total = total + x.Value + len }; clear()` (no call in the loop) | accepted, prints `2` | `GS0158` on `x.Value` (R7 (e), under today's R14 reading of an imported getter; follows #5231) |
| q5d | `open class Base { var Count int32 }`, `class Derived : Base { prop Count int32 { get { clear(); return 0 } } }` (hiding a field with a getter that clears a guarded closure-assigned root `x`); `let b Base = Derived(clear)`; guard; loop body `total = total + x.Value; if b is Derived { let c = b.Count }`, run for two iterations | accepted; throws `NullReferenceException` on the second iteration | `GS0158` on `x.Value` (R7 (e); M24) |
| q6 | `if skip { goto Inside }; if s == nil { return 0 }; while count < 3 && s.Length < 9 { Inside: count++ }` | `GS0158` on the header read (#4285) | `GS0158` on the header read (I2, J6); under the R6 slice without J6: accepted and the header dereferences nil |
| q7 | `while s != nil { if c { break }; s = Next(s) }; s.Length` | `GS0158` | `GS0158` (T1 exit) |
| q8 | guard; `do { n = n + s.Length; s = Next(s) } while n < 10` | `GS0158`, `GS0154` | `GS0158`, `GS0154` (T6; `Next(s)` still receives a `string?`) |
| q9 | guard; `Again: i = i + s.Length; for ... { s = nil }; s = Get(); if i < n { goto Again }` | `GS0158` | `GS0158` (I1, I9) |
| q10 | guard; `try { Again: i = i + s.Length; s = nil; if i < n { goto Again } } finally { return i }` | `GS0158` (#4285) | `GS0158` (section 11, participants: the `goto` does not leave the `try`, so it is a live back edge; M21) |
| q11 | guard; `while count < 3 && s.Length < 9 { Inside: count++; i++ }; s = nil; if i < n { goto Inside }` | `GS0158` on the header read (#4285) | `GS0158` on the header read (section 11, span entry: the span starts at the `while` statement and is bound from `L`; M22) |
| q12 | `var s string? = Get(c); while s == nil { s = "ok" }; return s.Length` | `GS0158` | accepted, prints `2` (R7 (f); M12) |
| q13 | as q12 with `return s!!.Length` | accepted, prints `2` | `GS0536` on `s!!` (R7 (f) compatibility; the `!!` is redundant after the loop) |
| q14 | guard; `try { while s.Length > 0 && n < 2 { n++; try { try { throw FormatException("f") } finally { throw InvalidOperationException("g") } } catch (InvalidOperationException) { } } } catch (FormatException) when Clear(ref s) { return -1 }` with `Clear` storing nil and returning true | accepted (warning GS0612 only); throws `NullReferenceException` at the header on the second iteration | `GS0158` on the header read (W8; M27) |

## Consequences

Positive:

- One rule for every region entry (`Lower`), one walker for every
  syntactic effect question (loops, spans, `when` filters), one kill
  predicate shared with straight-line code (A2). A soundness fix in the
  predicate fixes loops and spans the same day; the paired-fix pattern of
  #5170/#5171 ends.
- The per-loop lowering and CFG, the 21-structure snapshot, the
  diagnostics truncation, the second bind, `GotoNarrowingSnapshot.gs` and
  the goto proof machinery in `BinderContext.gs` are deleted: the study's
  M1b target is reached. `narrowing.loop-rebinds` goes to zero and is
  removed.
- q3's hole (an escaped closure invoked by a callee, in a loop) closes by
  construction; the optimistic-bind hazard of section 3d cannot occur.
- Construction-syntax dependence (#5169) and cross-function syntax
  reading (e3) are gone; results depend on the function's own syntax and
  the entry state.
- No fixed point, no widening, no iteration: the cost is one cached walk.

Negative:

- Less permissive rows R7 (a), (b), (c), (e) and R8 (a), (a'): programs
  that relied on the exit-path exemption, on a variable or call as
  non-null proof, on a loop with a call not touching an indirect-write
  root, on a member read not being a call, or on cleanup order before a
  backward jump get `GS0158`/`GS0159`. One known restructuring in
  `src/Core` (R7 (b)); the rest measured in L0.
- One output change in accepted programs, R7 (d).
- The walker is a syntactic notion of "writes" beside the bound effects
  (ADR-0208 already has one for filters; this ADR makes it the only one).
- cC changes from accepted to rejected (question 5).

Neutral:

- The exit state of a loop, the `finally` and `catch` rules, the join type
  rule and the construct table are ADR-0208's; this ADR only supplies the
  entry state of two constructs.
- #5142's one CFG per body is still not a prerequisite; if it lands, the
  walker may read assigned roots from it.

## Alternatives considered

- **A fixed point over the loop with re-bind** (today's two-iteration
  scheme, kept for good). Rejected by #5130's acceptance ("no second bind
  of loop bodies"), by the snapshot's maintenance record (section 3a) and
  because the fixed point's only input that syntax cannot give, the
  exit-path exemption, is load-bearing nowhere measured.
- **A fixed point without re-bind: compute the loop's entry state by
  iterating the transfer functions over the bound body of the first pass,
  then re-bind only if it differs.** It is the re-bind in disguise: the
  bound body of the first pass carries types that the recomputed state
  invalidates, and section 1 of ADR-0208 forbids rewriting them.
- **Bind loops once optimistically and report deferred diagnostics** (the
  backward-`goto` mechanism generalised). Rejected by ADR-0208 and by
  section 3d: it is correct only if every consumer of narrowed state is
  enumerated and tracked, and `GS0536`, the emitted `castclass` and the
  ADR-0186 elision are not.
- **Kill everything at loop entry** (no P7, no W1). Rejected: 12 errors
  in one Core function for the proof and e16 for the names; both rules are
  cheap and derived from the table.
- **Name-based kill set without scoping** (W1 without the declaration
  stack). Rejected: e16 compiles today and the #2943 symbol-identity rule
  was added for it.
- **Keep the per-loop CFG for the exit-path exemption only.** Rejected:
  it keeps the lowering and the graph for a rule with zero measured
  sites; if a consumer needs it later, #5142's shared CFG is the place.
- **Model cleanup order in the span kill set** (keep cC). Rejected for the
  same reason; question 5 lets the maintainer overrule.
- **A loop-only callee exemption** (question 3). Rejected: unsound (q3)
  and a second definition of the call rule.
- **Treat every function with a `goto` as one span.** Simpler than the
  shallowest-list rule; rejected because it kills facts in code before
  the first label and after the last `goto`, which R6 of ADR-0208 just
  made join normally; the span rule's extra precision costs one scan.

## References and reproducibility

- Probes of this ADR: `~/.cache/adr-loops/probes/q*.gs`, run with
  `bash ~/.cache/adr-loops/probes/run.sh [gsc.dll]`; the default compiler
  is the pinned 0.5.212 SDK's `tools/compiler/gsc.dll`. Section 24 lists
  each shape; slices L1 and L2 commit them as corpus rows.
- The ADR-0208 draft with the loop and backward-jump design and the R7/R8
  inventories: `git show 001ee4ff5:docs/adr/0208-narrowing-as-flow-state-with-a-query.md`,
  sections 10, 16 and 21.
- Code references are to `main` at `576f22f00` (#5295); the cited files
  under `src/Core/CodeAnalysis/Binding/` are those of PR 2 slice 1
  (#5230) and the three soundness fixes (#5211, #5213, #5214).
- Repository compile with a built compiler and `build/compiler-bench.py`:
  as ADR-0208's References section.
- Kotlin K2 precedent: the local-variable assignment analysis pre-pass
  collects, per loop and lambda, the variables assigned inside it; the
  dataflow analysis then treats those variables as unstable at the loop
  entry. The walker of section 7 is that pre-pass with the construct table
  as its effect vocabulary.
