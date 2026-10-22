# ADR-0208: Narrowing as a flow-state computation consumed through a query

- **Status**: Proposed
- **Date**: 2026-10-22
- **Phase**: Compiler architecture (study roadmap item M1b; design only,
  implementation is [#5130](https://github.com/DavidObando/gsharp/issues/5130))
- **Issue**: [#5129](https://github.com/DavidObando/gsharp/issues/5129)
- **Related**: [#2189](https://github.com/DavidObando/gsharp/issues/2189)
  (compiler performance umbrella),
  [#5128](https://github.com/DavidObando/gsharp/issues/5128) and PR
  [#5152](https://github.com/DavidObando/gsharp/pull/5152) (M1a, shared
  per-statement effect summaries),
  [#5142](https://github.com/DavidObando/gsharp/issues/5142) (one
  region-aware CFG per body),
  [ADR-0069](0069-smart-cast-flow-narrowing.md) and its addenda (#712,
  #1180, #2442, #2943, #4216, #4989),
  [ADR-0183](0183-narrow-immutable-fields-and-properties.md),
  [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md),
  [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md),
  [ADR-0154](0154-test-oracle-strength.md),
  [ADR-0203](0203-measured-compiler-throughput-and-bounded-parallelism.md),
  [compiler architecture and performance study](../compiler-architecture-and-performance-study.md)
  sections S5, S7, P3, 4.7 and decision 3 of section 10.

## Context

### 1. In G#, the narrowed type is the type

Smart-cast narrowing (ADR-0069 and addenda) changes the type that a read of a
local, parameter, read-only global or stable member path has at a program
point. Member lookup, overload resolution, conversions and emit consume that
type: `BoundVariableExpression.NarrowedType` drives a `castclass` or
`unbox.any` at the read site, `GS0536` (redundant `!!`) is decided from it
(`src/Core/CodeAnalysis/Binding/ExpressionBinder.Operators.gs:163-191`), and
ADR-0186 section 6 elides the platform nil check inside a narrowed region.
This is unlike C#, where nullable flow state only produces warnings after
binding. A post-bind flow pass cannot carry G#'s narrowing, because binding
has to see the narrowed type while it binds. Narrowing facts therefore have to
be available in flow order, during the single pass that binds a body. The
study records this constraint in S7.

### 2. The implementation today is a scope-stack interpreter

The narrowing state is a list of mutable frames,
`BinderContext.NarrowedVariables List[Dictionary[AccessPath, TypeSymbol]]`
(`src/Core/CodeAnalysis/Binding/BinderContext.gs:333`). Every statement list
pushes a frame (`StatementBinder.gs:456-465`), every `if` branch, switch arm,
`&&`/`||` right operand and closure body pushes another
(`StatementBinder.Conditionals.gs:855-884`, `ExpressionBinder.gs:210-234`,
`ExpressionBinder.Operators.gs:1004-1015`, `LambdaBinder.gs:532-549`). The
read-side query walks the frames innermost first
(`ExpressionBinder.gs:886-913`, `ApplyMemberNarrowing` at `:924`).

Facts enter the frames from four places and leave them through a chain of
post-statement passes that run after every statement of every block
(`StatementBinder.gs:697-737`):

| Pass | What it does | Where |
| --- | --- | --- |
| `ApplyMemberNotNullNarrowings` | `[MemberNotNull]` post-conditions of a call statement | `StatementBinder.Narrowing.gs:91` |
| `ApplyEarlyExitNarrowings` | lifts the else-frame of an `if` whose then-branch exits; post-switch lift | `:614` |
| `InvalidateNarrowingsForAssignedVariables` | drops facts for roots the statement assigns, all member paths when it calls or mutates a member | `:230` |
| `RestoreEarlyExitLiftsWrittenOnlyByCondition` | puts back a lift that the invalidation pass removed because the condition wrote the root through `out` | `:168` |
| `ApplyAssignmentNarrowing` | `x = nonNullValue` narrows a nullable `var` | `:684` |
| `UpdateExternalCallableAliases` | tracks which locals definitely hold external callables | `:341` |
| `ApplyIfJoinNarrowings` | re-interprets both bound branches of a fall-through `if` to find roots left non-null on both | `:1311-1512` |
| `ApplyTryFinallyFallthroughNarrowings` | applies a `finally` block's summary | `:1067` |

The interpreter behind `ApplyIfJoinNarrowings` (`ComputeIfJoinNonNull`,
`ProcessBranchStatement`, `ClearAssignedRoots`, `:1359-1610`) re-derives the
condition frames (`ComputeConditionNarrowing`, `:1519`) and re-walks the bound
branches. It handles `if` and plain blocks exactly and treats everything else
conservatively; the comment at `:1463-1464` says "Without a CFG, retain only
entry facts untouched by the whole block".

Loops bind the body, lower it, build a `ControlFlowGraph`, find the writes
that reach the back edge (`CollectLoopBackEdgeMutations`, `:556-606`) and, if
one invalidates an inherited fact, restore 21 snapshotted structures,
truncate the diagnostics and bind the body a second time
(`StatementBinder.Jumps.gs:241-414`, snapshots at `:283-316`).

`goto` has a third mechanism. A forward `goto` records a
`GotoNarrowingSnapshot` (`GotoNarrowingSnapshot.gs:24-124`) that the label
joins (`InvalidateAssignmentNarrowingsBypassedByGoto`, `:720-838`). A
backward `goto` binds the label region optimistically, records every
narrowing-dependent read with a proof generation
(`BinderContext.gs:83-89, 695-960`) and re-reports diagnostics after the fact
(`ReportUnsafeBackwardGotoNarrowings`, `:853-918`). Because a jump can bypass
a guard, any user label or `goto` in a function switches off the early-exit
lift and the `if` join for the whole function (`:634-637`, `:1314-1316`;
issues #4285 and #4290).

`StatementBinder.Narrowing.gs` is 4,418 lines; `AssignedRootsCollector`, the
walker that computes a statement's effects, is about 940 of them (`:1615`).

### 3. The measured problem

The study's sample profile of the Core compile (section 4.7) attributes 5.9%
of main-thread samples to `AssignedRootsCollector`, 6.6% to
`UpdateExternalCallableAliases` plus `InvalidateNarrowingsForAssignedVariables`,
1.1% to the `HashSet` copies of `CaptureCallableState`, and 17.9% inclusive to
`BindIfStatement` (which includes binding the branches). The cost is
O(depth x size): the enclosing block repeats the walk for each nested
statement, and `ApplyIfJoinNarrowings` walks both branches again.

PR #5152 (M1a) shares one effect summary per statement between the
invalidation pass and the alias update (`GetStatementEffects`, `:363-382`,
counters `narrowing.effect-walks` and `narrowing.effect-reuses`). On a Core
compile it reused 29,679 of 87,670 walks and moved the `bodies` phase from a
median of 20,493 ms to 17,820 ms (-13%, ranges overlap) and from 7,962 MB to
7,757 MB allocated (-2.6%), with byte-identical output. The maintainer's note
on #5130 lists what it did not do: the `if` join still re-walks both
branches, the loop re-bind is unchanged, `ClearAssignedRoots` is unchanged,
and the alias update still walks when no invalidation walk exists.

### 4. What the current rules accept and reject

The probes below were compiled with the pinned released compiler, 0.5.212
(`~/.nuget/packages/gsharp.net.sdk/0.5.212/tools/compiler/gsc.dll`). The
sources are listed in section 24. "Accepted" means no diagnostic; the
diagnostic is `GS0158 Cannot find member` or `GS0159 Cannot find function`
on the nullable receiver unless stated.

| Probe | Shape | 0.5.212 |
| --- | --- | --- |
| e1 | `if s == nil { s = "a" }` then `s.Length` | accepted (`if` join, #2159) |
| e2 | loop body: `if c { s = nil; break }` then `s.Length` | rejected |
| e2b | loop body: `s.Length` then `if c { s = nil; break }` | accepted (exit-path write exemption, #2943) |
| e3 | guard, then loop body: `node.Value` then `node = Make()` where `Make() Node` | accepted (non-null proof through the callee's syntax, #2943) |
| e4 | same with `node = node.Next` (`Node?`) | rejected |
| e5 | `if s == nil { s = "a" }`, an unrelated `goto`, then `s.Length` | rejected (#4290) |
| e6 | guard; `try { s = nil; Boom() } catch { s.Length }` | rejected |
| e7 | `if b.Pet == nil { return }` then `b.Pet.Name` (`let Pet`) | accepted (member path lifted) |
| e7/Run2 | `if b.Pet is Dog { } else { return }` then `b.Pet.Bark()` | rejected |
| e7/Run3 | `if b.Pet !is Dog { return }` then `b.Pet.Bark()` | accepted |
| e8 | `if s != nil { ... } else { return }` then `s.Length` (`let s`) | rejected |
| e9 | `switch k { case 1 { s = "a" } case 2 { s = "bb" } default { return } }` then `s.Length` | rejected |
| e10 | `{ if s == nil { return } }` then `s.Length` | rejected |
| e11 | `s!!.Length` then `s.Length` | rejected (`!!` does not narrow later reads) |
| e12 | both branches assign; one branch also contains a loop | accepted |
| e13 | `while node != nil { ...; node = node.Next }` | accepted (condition re-proves) |
| e14 | guard, then `() -> s.Length` with `var s` | rejected (#2442) |
| e15 | `again: i = i + s.Length; s = "ab"; if i < n { goto again }` | rejected |
| e16 | loop body declares its own `var s` and assigns it | accepted (symbol identity, #2943) |
| e17 | guard; `if c { s = nil; return -1 }` then `s.Length` | rejected |
| e18 | guard; `again: i = i + s.Length; if i < n { goto again }` (no write) | rejected (#4285) |
| e19 | try/finally inside a branch; `finally { s = "f" }` | accepted |
| e20 | top-level `let a Animal = Dog()`; `if a is Dog { a.Bark() }` | rejected |
| e21 | `if string.IsNullOrEmpty(b.Name) { return }` then `b.Name.Length` (`let Name string?`) | rejected; the nil-guard form `if b.Name == nil { return }` is accepted |

e20 contradicts ADR-0069's #712 addendum and `website/docs/ref/spec.md`,
which say a read-only top-level `let` narrows; the test
`Issue700SmartCastBinderTests.If_IsTest_OnGlobalVariable_DoesNotNarrow`
pins the rejection. This ADR does not change it; the documentation gap is
filed separately.

Two experiments measured the cost of the loop rule in section 10 on the
compiler's own source. Both built the compiler from this worktree with a
local, uncommitted edit to `CollectLoopBackEdgeMutations` and then compiled
the `GSharp.Core`, `GSharp.Core.Tests` and `gsc` response files with it
(0 errors with the unmodified build, as control):

- Kill every inherited fact whose root is assigned anywhere in the loop, with
  no non-null proof: 12 errors (`GS0158`), all in one function,
  `src/Core/CodeAnalysis/Binding/ExpressionBinder.Assignments.gs:5435-5494`.
  The shape is `var access T? = ...; if access == nil { return }; while true
  { ...access.Member...; access = inner }` where `inner` is a pattern
  variable. 0 errors in Core.Tests and in gsc.
- Kill every inherited fact whose root is assigned anywhere in the loop,
  keeping today's bound non-null proof (`AssignmentPreservesNarrowing`):
  0 errors in all three.

So on this code base the exit-path exemption is never load-bearing, and the
non-null proof is load-bearing once.

### 5. Constraints

- The maintainer approved a semantics change for this redesign (study
  section 10, decision 3). Corner cases where the result changes are a
  language change and are listed in section 16 with their compatibility
  position.
- The N-1 rule: the implementation is compiled by the pinned compiler, and
  the new compiler compiles the repository only at the next pin move.
- Emit must stay byte-for-byte deterministic (#4663).
- Nullability questions go through the ADR-0193 funnel; this ADR must not add
  a new "is this nullable" computation.
- The language server reads narrowed types from the bound tree through
  `BoundSemantics` (ADR-0069, #4989 addendum) and must keep working without
  a second computation.

## Decision

### 6. The model

Narrowing becomes a forward flow-state computation that runs inside the one
binding pass. The state at a program point is a value, `NarrowingState`,
that holds two kinds of facts:

- a map from `AccessPath` to the narrowed `TypeSymbol`;
- the set of variables that definitely hold an external callable (today's
  `externalCallableAliases`, `StatementBinder.Narrowing.gs:23`).

Both facts join the same way (a fact survives a merge only when every
incoming path has it, with the same type), so one record carries both and
`AssignedRootsCollector`'s alias machinery folds into the same state.

Binding threads the state forward: every statement is bound under an entry
state and produces an exit state (or `Unreachable`); every branch point
binds its branches under derived states and joins the exit states the
branches were bound under. Nothing re-walks a bound tree to recover what the
binder knew when it produced that tree. The frame stack, the side tables
`PendingEarlyExitFrames`, `PendingSwitchExitFrames`,
`AssignmentNarrowingGenerations`, the proof generations and
`GotoNarrowingSnapshot` are artifacts of the stack design and are deleted.

`NarrowingState` is immutable. Operations return a new value; a branch keeps
a reference to the state it started from and cannot disturb the other
branch. States are small (a handful of entries) and most statements leave the
state untouched, so the representation is an ordered immutable array of
`(path, type)` entries with copy-on-write; equality is structural.

### 7. The query API that binding consumes

```gs
/// Flow facts at one program point. A value: operations return a new state.
internal sealed class NarrowingState {
    static prop Empty NarrowingState { get; }
    /// Bottom. The identity of Join; the exit state of return, throw, goto,
    /// break and continue.
    static prop Unreachable NarrowingState { get; }
    prop IsUnreachable bool { get; }

    /// The query. Returns the narrowed type of a stable path, or nil.
    func NarrowedType(path AccessPath) TypeSymbol?
    func IsExternalCallable(variable VariableSymbol) bool

    /// Facts in.
    func With(path AccessPath, narrowedType TypeSymbol) NarrowingState
    func WithAll(facts IReadOnlyDictionary[AccessPath, TypeSymbol]) NarrowingState
    func WithExternalCallable(variable VariableSymbol) NarrowingState

    /// Facts out, from the effects of a bound node (section 8).
    func Kill(effects StatementEffects) NarrowingState
    func KillRoots(roots LoopKillSet) NarrowingState

    /// Merge. Intersection on paths with equal types; intersection on aliases.
    /// Unreachable is the identity.
    func Join(other NarrowingState) NarrowingState

    /// The state a closure body starts from (ADR-0069 #2442 rule).
    func ForClosureBody() NarrowingState
}
```

`BinderContext.Narrowing NarrowingState` replaces `NarrowedVariables`.
`ExpressionBinder.TryGetNarrowedType(variable)` and
`TryGetNarrowedType(path)` become
`binderCtx.Narrowing.NarrowedType(AccessPath.ForVariable(variable))` and
`binderCtx.Narrowing.NarrowedType(path)`. The read sites
(`BuildNarrowedVariableRead`, `ApplyMemberNarrowing`) do not change shape:
they still record the narrowed type on the bound node. The bound tree stays
the record the emitter, the analyzers and the language server read.

A per-body `NarrowingFlow` owns what the state alone cannot:

```gs
internal sealed class NarrowingFlow {
    /// Jump states waiting for their target: break/continue labels, user
    /// labels, loop exits. A jump through cleanup regions is recorded with
    /// the regions still to run (section 9).
    func RecordJump(target BoundLabel, state NarrowingState, pendingCleanup ImmutableArray[GotoCleanupRegion])
    func JoinJumps(target BoundLabel) NarrowingState
    /// The roots a loop or backward-goto region may assign (section 10),
    /// computed once per syntax node.
    func LoopKills(region SyntaxNode, scope BoundScope) LoopKillSet
}
```

### 8. Transfer functions

The state changes at these points, in evaluation order, inside expressions
as well as between statements.

Facts in:

- A condition classified by the existing classifiers (`TryClassifyNilGuard`,
  `TryClassifyBoolCallNarrowing`, `TryClassifyTypeTestNarrowing`,
  `ClassifyIfConditionNarrowing` at `StatementBinder.Conditionals.gs:25-44`)
  yields a then-state and an else-state. `!` swaps them; `&&` binds the
  right operand under the left then-state and intersects else-states;
  `||` is the dual; `??`, `?:` and the `if` expression use the same
  classification (ADR-0064 #4964 addendum). None of this changes.
- `x = value` where `TryClassifyNonNullAssignment` holds (`:1145-1175`)
  adds `x` at its declared type with one nullable layer removed (ADR-0069
  #4989 addendum: never the assigned class).
- A call statement whose callee carries `[MemberNotNull]` adds the named
  implicit fields (`ApplyMemberNotNullNarrowings`, unchanged).
- Pattern variables and `if let`/`guard let`/`while let` bindings keep their
  scoping rules (ADR-0166, ADR-0201); they are scope facts, not state facts.

Facts out, from a node's `StatementEffects` (section 13):

- An assignment to a root removes every path with that root.
- A member, index or indirect assignment, or any call, removes every
  member-bearing path (ADR-0069 #1180 rule, unchanged).
- A call to a function with captures, or an indirect call whose target is
  not a known external callable, removes paths whose root a closure of the
  function may assign (`MayBeAssignedByClosure`, `BinderContext.gs:731`),
  by-reference roots and member paths (`MayBeMutatedByUnknownCallable`,
  `:1540`). A write through a pointer of unknown origin removes every
  mutable root (`MayMutateAnyRootViaPointer`).
- An `out` or `ref` argument and an address-of operand write their root.
- A callable alias is removed when its variable is assigned a non-external
  value; it is added when assigned an external one
  (`ApplyCallableAliasExitState`, unchanged rule).

### 9. Joins come from the states the branches were bound under

- `if c { A } else { B }`: bind `c` under `S`, giving `S_then`, `S_else`
  and the state after `c`'s own effects. Bind `A` under `S_then` to `S_A`,
  `B` under `S_else` to `S_B` (with `S_B = S_else` when there is no else).
  The exit state is `S_A.Join(S_B)`. The early-exit lift (`if x == nil {
  return }`), the `if` join (#2159) and the else-exit case are all this one
  rule, because an exiting branch contributes `Unreachable`.
- `switch`: each arm is bound under the discriminator's arm facts; the exit
  state joins the exits of the arms that complete normally, plus the entry
  state when the switch is not exhaustive (the "no arm matched" path).
  Today's rule that every non-exiting arm must contribute the same
  discriminator narrowing (ADR-0069 #712) is exactly this join.
- A block's exit state flows to the statement after the block. A block no
  longer pops a frame; the scope ends, the facts about outer variables do
  not.
- `try { T } catch { C } finally { F }`: the catch entry state is the try
  entry state with the whole try block's effects killed (a throw can happen
  after any write); the finally entry state is the join of the try exit,
  every catch exit and the catch entry state; the statement's exit state is
  the finally's exit transfer applied to the join of the completing paths.
  `defer` and `using` cleanup regions are the same shape.
- A jump (`break`, `continue`, `return`, `throw`, `goto`) records its state
  on the target and yields `Unreachable`. A jump that leaves cleanup regions
  is recorded with the regions still to run; when a region's cleanup is
  bound, its exit transfer (`FinallyFlowSummary`: kill its effects, add its
  normal-exit facts) is applied to each pending state before the target
  joins it. This keeps the `GotoLeavingTry_*` and `*Finally*` results of
  `Issue4519GotoAssignmentNarrowingTests`.
- A user label is a join of the fall-through state and every recorded
  forward jump. Forward `goto` keeps its join rule, including the
  one-incoming-type-converts-to-the-others rule of the #4989 addendum
  (`FindCommonImplicitSupertype`); the predecessor list is in source order.

### 10. Loops and backward jumps: kill at entry, bind once

A loop body is bound once. Its entry state is the state before the loop
with these facts removed:

- every path whose root is in the loop's kill set;
- every member-bearing path, when the loop contains a call or a member,
  index or indirect assignment (the same test as today's
  `SyntaxMayMutateMemberPaths`, `:408-450`, which is already syntactic and
  cached per statement node).

The kill set is computed from the loop's syntax (header, body and post
statement) before the body is bound, once per loop node, by a walker that
extends today's `CollectAssignedNamesAndMemberMutation`:

1. **Scope-aware names.** The walker keeps a stack of names declared inside
   the region (`var`/`let` declarations, `for` headers, pattern variables,
   `if let`/`while let` bindings, lambda parameters, catch variables). An
   assignment to a name declared inside the region, in a scope that encloses
   the assignment, does not kill the outer variable (e16 keeps compiling).
   Every other assigned name is resolved at loop entry with
   `$scope.TryLookupSymbol`, as the syntax fallback at `:290-295` does
   today; a name that resolves to a variable is killed. A declaration form
   the walker does not recognise is treated as not declared, which kills
   the outer variable. Conservative is the safe direction.
2. **Every write in the region counts.** Writes on a path that leaves the
   loop (`break`, `return`, `throw`, `goto`) kill like any other. This
   removes the per-loop lowering and `ControlFlowGraph` and the
   `reachesBackEdge` search (`:578-604`). Section 4 measured this
   exemption as never load-bearing in Core, Core.Tests or gsc.
3. **Syntactic non-null proof.** An assignment whose right side is a
   non-nil literal, an object construction (`T(...)`, `T{...}` where the
   name resolves to a type and not to a function at loop entry; today's
   `IsDefinitelyNonNullSyntax`, `:1274-1288`), or an `!!` expression does
   not kill a nullability fact about its target. It still kills a type-test
   fact. The right side being a variable, a call or anything else kills.
   This keeps e3 with a constructor and drops
   `FunctionReturnsDefinitelyNonNull` (`:1248-1272`), which reads another
   function's syntax to decide a flow fact.
4. **Closures, references, pointers.** An assignment inside a lambda literal
   in the region kills. A call anywhere in the region kills every root in
   the function's closure-assigned name set (`ComputeClosureAssignedNames`,
   already syntactic and function-wide). `out`/`ref` arguments and `&x`
   operands kill their root. An indirect assignment through anything other
   than an address-of operand kills every mutable root.

Facts proven inside the body (`while x != nil`, a guard, an assignment that
narrows) are per iteration and unaffected; e13 keeps compiling. The exit
state of the loop is the join of the condition-false state (for a
conditioned loop) and the recorded `break` states, after the body's exit and
`continue` states have been joined into the condition point.

Soundness: a fact that survives the kill is about a root no statement in the
loop assigns (or assigns only a syntactically non-null value) and, if it is
a member path, no call or member write in the loop can reach. Such a fact
holds on the fall-in edge by assumption and on every back edge because the
root is unchanged; the entry state is therefore a sound fixpoint without
iteration or re-binding. Kotlin's K2 front end uses the same device: a
pre-pass over a function body collects the local variables each loop and
lambda assigns, and the dataflow analysis drops smart casts on them at the
loop head.

A **backward `goto`** is a back edge whose region is the label statement
through the last `goto` to that label in source order. The same walker runs
over that region, and the label's entry state is the fall-through state (and
any forward jumps) with the region's kill set applied. This replaces
`BackwardGotoNarrowingStates`, the proof generations,
`TrackBackwardGotoNarrowingUse`, `ReportUnsafeBackwardGotoNarrowings` and
`GotoNarrowingSnapshot`. Because the lift and join suppressions of #4285 and
#4290 existed only to protect the stack design from jumps, they are deleted
too: a jump that bypasses a guard reaches the label with a state that lacks
the guard's fact, and the join drops it.

### 11. Closures

`ForClosureBody()` applies the ADR-0069 #2442 rule unchanged: a closure body
starts from the enclosing state restricted to plain-variable paths whose
root is `IsReadOnly`, with no external-callable facts. The decision whether a
`var` that no closure assigns may keep its narrowing inside a closure is
open question 2; it is not part of this ADR.

### 12. Reachability

A statement's exit state is `Unreachable` when it ends in `return`, `throw`,
`rethrow`, `goto`, `break`, `continue`, an `if` whose both branches are
unreachable at exit, an exhaustive `switch` whose every arm is, a `try`
whose `finally` is, or a loop without a reachable `break` whose condition is
absent. Constant conditions are not folded. This is the set
`EndsInUnconditionalExit` and `CanCompleteNormally` (`:1001-1024`) compute
today from the bound shape; the definite-return check
(`ControlFlowGraph.AllPathsReturn`) on the lowered body is unchanged and
stays the owner of `GS0100`.

### 13. Effects: computed once, composed bottom-up

`StatementEffects` is an immutable record: assigned roots (ordered by
declaration order), writable-reference roots, and the flags
`MayMutateMemberPaths`, `MayMutateAnyRoot`, `MayMutateAnyRootViaPointer`,
`MayMutateGlobalRoots`, plus the callable-alias deltas. A compound
statement's effects are the union of its children's; a block's effects are
the union of its statements'. The binder records a node's effects in a side
table keyed by the bound statement when it finishes binding that statement,
so every node is visited once over the whole body instead of once per
enclosing block. This is where #5152's single-entry cache
(`effectsNode`/`effects`, `:29-31`) becomes a table and the counter
`narrowing.effect-walks` becomes equal to the statement count.

Caching and invalidation of the query itself are trivial: `NarrowedType` is
a lookup in a small immutable array; there is no cache to invalidate because
each state is a value tied to one program point. The expensive things today,
the re-walks, do not exist in this model. The only pre-bind work is the loop
kill set, cached per loop syntax node; it is a syntax walk with name
resolution at the loop entry scope, and runs only for loops entered with a
non-empty state (today's `HasActiveNarrowings` guard, `:519`, keeps its
role).

### 14. Nullability funnel and the language server

The state stores `TypeSymbol`s. "Strip one nullable layer" and "admits nil"
are asked through the ADR-0193 readers (`NullableTypeSymbol.UnderlyingType`
today, the `TypeSymbol` query members as they land); the GSA0007 producer
funnel applies to the implementation. Platform types (`T!`, ADR-0186) narrow
through the same leaf classifier (`SmartCastStability.gs:231` maps a
`PlatformTypeSymbol` target to its underlying type); this ADR does not change
that, and the ADR-0186 section 6 check elision keeps reading the narrowed
type from the bound node.

The language server does not recompute narrowing; it reads `NarrowedType`
from the bound tree through `BoundSemantics` (ADR-0069 #4989 addendum, the
`Issue4989BoundReceiverTests`). Nothing in this ADR changes that contract.
Because states are values, the binder can keep the entry state of each
statement in a side table at little cost; exposing it on `SemanticModel`
for hover or quick fixes (ADR-0099) is possible later and is not decided
here.

### 15. Determinism, bootstrap and N-1

- Joins are set operations on structurally ordered entries; no result
  depends on hash order. The one order-sensitive join, the forward-`goto`
  common-supertype rule, takes its predecessors in source order, as today.
  No numbering or naming is derived from a hash-ordered collection (#4663).
- The redesign is ordinary source under the N-1 rule: the pinned compiler
  compiles it. The new compiler compiles the repository at the next pin
  move, and that is where the semantics change meets the compiler's own
  source. Two hazards:
  1. **Less permissive rows** (section 16) can reject repository source. The
     measurement in section 4 found one function
     (`ExpressionBinder.Assignments.gs:5435-5494`) for the loop rule. The
     fix is a restructuring (declare `access` non-nullable from the first
     element), not `!!`: under the pin, the pinned compiler proves the
     value non-null there and reports `GS0536`, and warnings are errors, so
     `!!` cannot bridge the two compilers. The implementation PRs compile
     Core, Core.Tests and gsc with the built compiler (the response-file
     procedure in section 24) and land such restructurings before the pin
     moves.
  2. **More permissive rows** make some `!!` in repository source
     provably redundant (`GS0536`). `src/Core` has 3,746 `!!`. The pin-move
     PR for the release that carries this ADR removes the `!!` the new
     compiler reports; nothing can be removed before that because the pin
     still needs them. The comparison mode (section 19, PR 1) lists them
     ahead of time.
- Emitted output: a nullability fact that newly survives a join emits no
  cast (same CLR type). A type-test fact that newly survives a join emits a
  `castclass`/`unbox.any` at reads after the join, so IL can change in
  programs that compile with and without this ADR. The comparison mode
  classifies every such site under a row of section 16; an unclassified
  difference is a blocker.

### 16. Observable semantic changes

Each row: the shape, today's result on 0.5.212, the result under this ADR,
the direction, the diagnostics affected, the tests that change, and the
compatibility note. "Probe" refers to section 4.

| # | Shape | Today | After | Direction |
| --- | --- | --- | --- | --- |
| R1 | Then-branch fact survives when the else-branch exits: `if s != nil { A } else { return }` then `s.Length` (e8); `if b.Pet is Dog { } else { return }` then `b.Pet.Bark()` (e7/Run2) | GS0158 / GS0159 | accepted | more permissive |
| R2 | Assignment in a branch that exits does not kill the fact after the `if`: guard, `if c { s = nil; return }`, then `s.Length` (e17) | GS0158 | accepted | more permissive |
| R3 | A fact lifted inside a nested bare block survives the block: `{ if s == nil { return } }` then `s.Length` (e10) | GS0158 | accepted | more permissive |
| R4 | Facts established in switch arms join after the switch: arms assign `s` non-null, `default` returns, then `s.Length` (e9); nested loops, `try`, labelled blocks inside branches contribute their exit state instead of `ClearAssignedRoots` | GS0158 | accepted | more permissive |
| R5 | Member paths and type-test facts take part in every join, not only in the early-exit lift; a `[NotNullWhen]`-derived member-path fact lifts past an early return like a nil-guard fact does (ADR-0069 #4216 addendum, second bullet) | GS0158 / GS0159 | accepted | more permissive |
| R6 | A user label or `goto` elsewhere in the function no longer disables lifts and joins: e5 (`goto` after an `if` join), e18/Run (guard, label, read, backward `goto`, no write) | GS0158 (#4285, #4290) | accepted | more permissive |
| R7 | Loop entry kills every inherited fact whose root the loop assigns: read before an exit-path write (e2b; the `break-only` shape of `Issue2943LoopBackEdgeNarrowingTests`), and reassignment from a variable or a call (the `access = inner` shape in Core; the function/variable rows of `NonNullAssignmentAfterUse_PreservesInheritedNarrowing`) | accepted | GS0158 / GS0159 / GS0503 | less permissive |
| R8 | Backward `goto`: the label entry kills what the label-to-goto region assigns; the deferred re-report path is gone. A region that reassigns the root from a variable or a call and that the deferred proof accepted today is rejected at the read | accepted in the deferred-proof cases; GS0158/GS0155/GS0159 otherwise | GS0158 / GS0159 at the same reads; GS0155 no longer re-reported | less permissive in the deferred-proof cases, otherwise same ids at the same locations |
| R9 | Invalidation is expression-granular: `s != nil ? consume((s = nil), s.Length) : 0` (ADR-0064 L576-581, #4985) | accepted, dereferences nil at run time | GS0158 | less permissive (soundness) |

Details per row:

- **R1-R4, R6.** These are consequences of one join rule (section 9). No new
  diagnostic; `GS0158`, `GS0159` and `GS0503` stop firing where the fact now
  holds. Tests: `Issue2159IfJoinNarrowingTests` gains the else-exit and
  exiting-branch shapes; `Issue712FlowNarrowingExtensionsBinderTests` gains
  the arm-assignment shape; `Issue4285GotoNarrowingReachabilityTests` (14
  tests) are re-expected one by one: the bypass cases
  (`Goto_BypassesNilGuard_DoesNotNarrowFieldPath`, `*GuardLetElse*`,
  `*PatternVariableLeak*`) keep their rejection because the bypass path
  reaches the join without the fact; the cases that only assert "a `goto`
  elsewhere suppresses" flip to accepted. `Issue4519` forward-`goto` rows
  (`ForwardGoto_*`, `MultipleGotosToSameLabel_IntersectTheirNarrowingStates`,
  `ForwardGoto_JoinsFallthroughAndIncomingToCommonSupertype`) are joins and
  keep their results. Compatibility: programs that compile today compile
  after; `!!` written for these shapes becomes `GS0536` (section 15).
- **R5.** e21 shows the asymmetry: the nil-guard form lifts the member path
  and the predicate form does not. `Issue4216IsNullOrEmptySmartCastTests.gs:
  235` (`MemberPathNarrowing_IsNotLiftedPastAnEarlyReturn`) pins it, and its
  comment asks that a change be a deliberate decision; this row is that
  decision, and the test flips to accepted. The join lifts whatever the
  false-branch state holds, so if PR 2 finds that `TryClassifyBoolCallNarrowing`
  itself withholds the member-path fact for the false branch, that is a
  classifier gap to close in the same PR, not a reason to keep the row open.
  The #4216 addendum's second scope bullet is superseded by this ADR.
  Compatibility as R1.
- **R7.** Tests: `Issue2943LoopBackEdgeNarrowingTests` `break-only` moves to
  the rejected shapes; `NonNullAssignmentAfterUse_PreservesInheritedNarrowing`
  (`:166-224`) keeps its `constructor` rows (`c = C(33)`) and moves its
  `local` (`c = fresh`) and `function` (`c = Mk(33)`) rows to rejected;
  `SpeculativeRebind_*` (`:444-551`) test
  the re-bind and are deleted or rewritten against the kill set; the
  `Issue2943LoopBackEdgeNarrowingEmittedOracleTests` rows are re-run.
  Compatibility: one function in `src/Core` needs a restructuring (section
  15). Users see `GS0158`/`GS0159` where they relied on the exemption; the
  fix is to re-test inside the loop or to declare the loop variable
  non-nullable. ADR-0069's #2943 addendum paragraphs "A write on a path that
  exits the loop ... does not invalidate the body" and "user functions whose
  returns are all proven non-null may preserve a narrowing" are superseded.
- **R8.** Tests: `Issue4519GotoAssignmentNarrowingTests` `BackwardGoto_*`
  (`:155-365`, `:3305`, `:3558`, `:3634`, `:1463-1612`) are re-expected
  against the kill rule; the implementation PR shows for each that the
  diagnostic id and location are unchanged or records the row here. e15 and
  e18/Run2 stay rejected. Compatibility: user `goto` is rare; no occurrence
  in `src/Core`.
- **R9.** New test with an ADR-0154 witness (red on today's compiler by
  running the program). Compatibility: the program is wrong today; the
  diagnostic is the fix. `a ??= b` narrowing afterwards (#4978) becomes
  expressible in the same model; whether to enable it is #4978's decision.

### 17. Not changed

- What narrows and what paths are stable (`SmartCastStability`): locals,
  parameters, implicit fields, stable member paths; e20's global behaviour.
- Member-bearing paths die on any call or member write (ADR-0069 #1180).
- Assignment narrowing proves non-nil, never the assigned class (#4989).
- The #2442 closure rule (e14 stays rejected).
- `!!` is a runtime check and does not narrow later reads (e11 stays
  rejected; open question 1).
- `catch` entry sees the try block's writes (e6 stays rejected); `finally`
  exit transfer (e19 stays accepted); `while x != nil` re-proves per
  iteration (e13); nullable reassignment in a loop kills (e4); shadowing in
  a loop (e16).
- `[MemberNotNull]`, `[NotNullWhen]`, `[MaybeNullWhen]`, `[MemberNotNullWhen]`
  rules; `if let`, `guard let`, `while let`, pattern-variable scoping
  (ADR-0166, ADR-0201); the `&&`/`||`/`??`/`?:` classification; `GS0536`
  rules including the ADR-0186 `T!` exemption; `GS0523` suppression on
  narrowed reads.
- Async and iterator bodies: narrowing is decided at bind time on the
  unlowered body; `await` and `yield` do not invalidate locals.
- Definite assignment (`DefiniteAssignmentAnalyzer`) and definite return are
  separate analyses on the lowered body and are untouched; #5142 may later
  share its CFG with the loop walker of section 10 without changing a
  result.

### 18. Performance expectations

With the study's profile as the baseline (section 4.7) and #5152 landed:

- The per-statement bound walks disappear as a class: effects are composed
  once per node (`narrowing.effect-walks` equals the statement count,
  `narrowing.effect-reuses` is retired).
- No lowering, `ControlFlowGraph` or second bind per loop. A new counter,
  `narrowing.loop-rebinds`, is added in PR 1 to measure how many loop bodies
  the current design binds twice on Core, so the saving is known before it
  is removed.
- `ApplyIfJoinNarrowings` and `ClearAssignedRoots` disappear; the 21-entry
  loop snapshot and its `Clone()`s disappear; `CaptureCallableState` copies
  disappear with the alias set folded into the state.
- Expected: the narrowing-attributable frames
  (`AssignedRootsCollector` 5.9%, `UpdateExternalCallableAliases` +
  `InvalidateNarrowingsForAssignedVariables` 6.6%, alias-set copies 1.1%)
  fall to under 3% of main-thread samples, and the `bodies` phase drops by a
  further 5-10% after #5152's 13%. These are estimates; the implementation
  PRs report the measured table from `build/compiler-bench.py` (#5163) if it
  has merged, else `build/selfhost-bench.py`, over the Core, LanguageServer
  and hello-world cells, with `GSHARP_MEASURE_PHASES` phases and counters.

### 19. Implementation plan (#5130)

Each PR: narrowing conformance suite green except the rows it lands; every
new or changed behavioural test carries an ADR-0154 witness (red on the
pre-change compiler or under a mutant); byte-identical implementation,
reference, PDB and XML output and identical diagnostics on Core, Core.Tests
and the pinned Oahu inputs except where the PR's rows predict a change,
each predicted change listed in the PR body; the benchmark table of section
18; and a compile of Core, Core.Tests and gsc with the built compiler
(section 24) with zero diagnostics outside the landed rows.

1. **Representation (no semantics change).** `NarrowingState`,
   `StatementEffects` composed bottom-up in a side table, `BinderContext.
   Narrowing`, and the query. The frame list becomes save/restore of a state
   value; every existing pass keeps its rule. Adds `narrowing.loop-rebinds`.
   Adds the **comparison mode** `GSHARP_NARROWING_COMPARE=<path>`: the
   binder runs the old join interpreter next to the new join and writes
   every disagreement as `file:line, path, old type, new type, row`.
   Acceptance: byte-identical output; zero disagreements on Core, Core.Tests
   and Oahu, since this PR changes no rule.
2. **Joins from exit states (R1-R6, R9).** `if`, `switch`, blocks, `try`,
   cleanup regions, forward `goto`, labels; expression-granular state
   updates; delete `ApplyIfJoinNarrowings`, `ComputeIfJoinNonNull`,
   `ProcessBranchStatement`, `ClearAssignedRoots`,
   `RestoreEarlyExitLiftsWrittenOnlyByCondition`, `PendingEarlyExitFrames`,
   `PendingSwitchExitFrames`, the #4285/#4290 suppressions. Acceptance: the
   comparison mode's disagreements on Core, Core.Tests and Oahu all fall
   under R1-R6 or R9; the listed tests re-expected with witnesses; the
   `GS0536` sites the new compiler reports in repository source are listed
   in the PR body for the pin-move PR.
3. **Loops and backward jumps (R7, R8).** The kill-set walker; delete
   `BindLoopBody`'s snapshot and re-bind, `CollectLoopBackEdgeMutations`,
   `LoopBackEdgeMutationCollector`, the per-loop CFG,
   `AssignmentPreservesNarrowing`, `FunctionReturnsDefinitelyNonNull`,
   `BackwardGotoNarrowingStates`, the proof generations,
   `ReportUnsafeBackwardGotoNarrowings`, `GotoNarrowingSnapshot.gs`.
   Acceptance: `narrowing.loop-rebinds` is gone and no second bind appears
   in the profile; the one Core restructuring lands first as its own small
   PR; `Issue2943` and `Issue4519` re-expected with witnesses.
4. **Cleanup.** Delete `AssignedRootsCollector` and the single-entry cache,
   fold the alias set into the state, remove the comparison mode, update
   ADR-0069's superseded paragraphs with pointers to this ADR, update
   `website/docs/ref/spec.md` section "Smart casts" and
   `website/docs/tour/control-flow.md`, release notes under Unreleased.
   Acceptance: `StatementBinder.Narrowing.gs` reduced to the classifiers
   and transfer functions; benchmark table; full suite green.

The pin-move PR after the release that carries PRs 2-3 removes the `!!`
that `GS0536` newly reports (section 15).

### 20. Risks

- **A rule the model cannot express without the interpreter.** Mitigation:
  PR 1's comparison mode runs both on Core, Core.Tests and Oahu before any
  rule changes; a disagreement there is a defect in the new model, not a
  row.
- **The kill-set walker misses a write form** (a new assignment syntax, a
  deconstruction, a compound operator). The failure direction is unsound
  (a fact survives a write). Mitigation: the walker treats every syntax kind
  it does not know that can carry an assignment as a write of every name it
  contains, and a test enumerates the assignment syntax kinds against the
  walker's list, so adding a kind without updating the walker fails.
- **IL churn from type-test facts at joins** (section 15). Mitigation: the
  comparison mode classifies every emitted-cast difference; if the churn on
  Oahu is large the maintainer can choose open question 3.
- **Bootstrap**: a less permissive row rejects repository source only at
  the pin move. Mitigation: the response-file compile in every
  implementation PR (section 24), and the restructuring in PR 3.
- **Performance regression from immutable states** in bodies with many
  facts. Mitigation: states are tiny arrays; the benchmark table gates each
  PR.

### 21. Open questions for the maintainer

1. Should `x!!` narrow `x` for the rest of the flow region (e11)? It is a
   runtime check, so it is sound; CLAUDE.md discourages `!!` as a flow
   device. This ADR proposes no.
2. Should a `var` local that no closure assigns keep its narrowing inside a
   closure body when no write to it follows the closure's creation point?
   The #2442 addendum declined path sensitivity. This ADR proposes to keep
   #2442 unchanged.
3. Should type-test facts (`is`) survive joins (R5) or only nullability
   facts, to avoid new `castclass` emission at join points? This ADR
   proposes uniform joins; the comparison mode measures the churn.
4. Rule 3 of section 10 drops the cross-function syntax proof
   (`FunctionReturnsDefinitelyNonNull`). Should a call to a function whose
   declared return type is non-nullable count as proof instead? ADR-0069's
   #2943 addendum rejected static non-nullability as proof under the old
   nullability mode; under ADR-0186 platform types the argument is weaker.
   This ADR proposes to keep it out and revisit with #4363.
5. Should the per-statement entry states be kept for `SemanticModel`
   (section 14) in PR 1, since they are free, or left out until a consumer
   exists?

## Consequences

Positive:

- One rule for every merge point, and one rule for every back edge. The
  irregularities of the stack design (a `goto` anywhere disables joins; a
  block pops its facts; an else-exit does not lift; switch arms do not
  join) go away as a class rather than shape by shape.
- The O(depth x size) walks, the `if`-join interpreter, the per-loop CFG and
  the second bind of loop bodies are removed structurally, with
  `StatementBinder.Narrowing.gs`, `GotoNarrowingSnapshot.gs` and the goto
  proof machinery in `BinderContext.gs` reduced to classifiers, transfer
  functions and one state type.
- A soundness hole closes (R9).
- The state is a value, which makes per-position queries for tooling
  possible later at no cost to batch compilation.

Negative:

- Two less permissive changes (R7, R8) and a known restructuring in
  `src/Core`. Users who relied on the loop exit-path exemption or the
  cross-function non-null proof get a diagnostic.
- IL can change at join points for type-test facts (section 15).
- A pin-move PR with `!!` removals.
- The kill-set walker is a second syntactic notion of "assigns" beside the
  bound effects; the enumeration test in section 20 keeps them aligned.

Neutral:

- ADR-0069 remains the semantics reference for what narrows; this ADR
  supersedes its implementation notes and the three #2943 and #4216
  paragraphs named in section 16. ADR-0183's window-widening decision is
  compatible with this model (a lifted member-path fact is just a fact in
  the state) and is not changed in status by this ADR.
- #5142's shared CFG is not a prerequisite. If it lands, the loop walker of
  section 10 can read the loop's assigned roots from the CFG instead of the
  syntax, with no change in results beyond the shadowing precision of rule 1.

## Alternatives considered

- **Keep the scope stack and read the #5152 summaries everywhere.** Removes
  the O(depth x size) walks but keeps the `if`-join interpreter (about 2,000
  lines with `AssignedRootsCollector`), the per-loop CFG and the second bind,
  and keeps the irregular rules (R1-R6 stay rejected). Rejected by decision
  3's goal that these disappear structurally.
- **A post-bind dataflow pass over the bound tree, Roslyn `NullableWalker`
  style, on #5142's one CFG per body.** The narrowed type is the type
  (section 1); every body would need a second binding under the computed
  types, doubling the binding phase, or deferred member and overload
  resolution. #5142's CFG is built from the lowered tree after binding, too
  late to feed binding. Rejected.
- **Memoize the interpreter** (`ComputeBranchFallthroughNonNull` per node).
  Keeps the interpreter and its approximations, needs invalidation when a
  frame mutates, and does not touch the loop re-bind. Rejected.
- **Keep the loop fixpoint with re-bind** (today's semantics exactly).
  Keeps the exit-path exemption and the bound non-null proof that one Core
  function uses. Rejected by #5130's acceptance ("no second bind of loop
  bodies") and by the measurement in section 4: the exemption is never
  load-bearing and the proof is load-bearing once.
- **Bind loops once optimistically and report deferred diagnostics**, the
  backward-`goto` mechanism generalised to loops. Rejected because the
  optimistic bind has effects the deferred checker cannot see or undo: a
  killed type-test fact leaves a `castclass` on reads that are valid on the
  wider type, so the program must be rejected (`GS0155`) where today's
  re-bind accepts it, or the bound tree rewritten, which section 1 rules
  out; `GS0536` reported inside the body on an optimistic fact is wrong
  once the fact dies, and warnings are errors; the ADR-0186 check elision on
  a dead fact is a miscompile. It is correct only if every consumer of
  narrowed state is enumerated and tracked, which is the shape-by-shape
  pattern this ADR removes.
- **Name-based kill set without scoping** (rule 1 without the declaration
  stack). Simpler, but rejects e16, which compiles today and which the
  symbol-identity rule of #2943 was added for.

## References and reproducibility

- Probes: `~/.cache/narrowing-adr/exp/e*.gs`, run with
  `bash ~/.cache/narrowing-adr/exp/run.sh [gsc.dll]`; the default compiler
  is the pinned 0.5.212 SDK's `tools/compiler/gsc.dll`. The sources of the
  probes named in section 4 are short; e2b, e8, e9, e10, e17 and e18 are:

```gs
// e2b: accepted today, rejected by R7
while i < n {
    total = total + s.Length
    if c {
        s = nil
        break
    }
    i = i + 1
}
// e8: rejected today, accepted by R1
let s string? = Get()
if s != nil { Console.WriteLine("y") } else { return 0 }
return s.Length
// e9: rejected today, accepted by R4
var s string? = nil
switch k {
    case 1 { s = "a" }
    case 2 { s = "bb" }
    default { return 0 }
}
return s.Length
// e10: rejected today, accepted by R3
var s string? = Get()
{
    if s == nil { return 0 }
}
return s.Length
// e17: rejected today, accepted by R2
var s string? = Get()
if s == nil { return 0 }
if c {
    s = nil
    return -1
}
return s.Length
// e18 (Run): rejected today, accepted by R6
var s string? = Get()
if s == nil { return 0 }
var i = 0
again:
i = i + s.Length
if i < n { goto again }
return i
```

- Repository compile with a built compiler (used for the two loop-rule
  experiments and required by section 19): build
  `src/Compiler/Compiler.gsproj` and `test/Core.Tests/Core.Tests.gsproj`
  with the pinned SDK; take `out/obj/{Core,Core.Tests,Compiler}/Release/
  {GSharp.Core,GSharp.Core.Tests,gsc}.rsp`; strip the BOM and redirect
  `/out:`, `/refout:`, `/pdb:` and `/doc:` into a work directory under
  `~/.cache/`; run `dotnet <built>/gsc.dll @<rsp>` from the project
  directory. `build/compiler-bench.py` (#5163) automates the same with
  output parity once merged.
- Code references in this document are to `main` at `51fcab9c9` (#5159).
- Kotlin K2 precedent: the compiler's local-variable assignment analysis
  pre-pass collects, per loop and lambda, the local variables assigned
  inside it; the data-flow analysis then treats those variables as unstable
  at the loop entry, so smart casts on them are dropped there.
