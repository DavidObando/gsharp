# ADR-0208: Narrowing as a flow-state computation consumed through a query

- **Status**: Accepted (maintainer decision on PR
  [#5164](https://github.com/DavidObando/gsharp/pull/5164), 2026-10-23, with
  the split scope of section 18a; the eight questions of section 21 were
  decided as recommended on the same day, three of them deferred to
  [#5196](https://github.com/DavidObando/gsharp/issues/5196))
- **Date**: 2026-10-22 (accepted 2026-10-23)
- **Amendments**: A1 (join fallback, #5206) and A2 (property reads, row
  R14, #5215) of section 19a, found by PR 1 of #5130 (#5212) and accepted by
  the maintainer on 2026-10-23 (PR #5226); the clarifications of #5207 are
  folded into the text
- **Phase**: Compiler architecture (study roadmap item M1b; implementation
  is [#5130](https://github.com/DavidObando/gsharp/issues/5130))
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

The probes that ground this section are compiled with the pinned released
compiler, 0.5.212, and listed with their results in the companion document
[ADR-0208 probe corpus](0208-narrowing-probe-corpus.md): 54 rows (e1 to e21,
c1 to cC, `out-alias`, d1 to d6, f1 to f6, g1 to g5). "Accepted" means no
diagnostic; the diagnostic is `GS0158 Cannot find member` or `GS0159 Cannot
find function` on the nullable receiver unless stated. In short: the e rows
are the shapes this ADR set out to change or to keep; the c, d, f and g rows
are review counterexamples against drafts of this ADR, of which cA, d1, d3,
d4, f2, f3, f5 and g2 are soundness holes in 0.5.212 (filed as #5168, #5170
and #5171), c8/c8b show a construction-syntax dependence (#5169), and the
rest are rejected today and stay rejected or are accepted programs whose
result this ADR changes (rows R1 (b), R1 (c), R13 of section 16).

Every probe in that table is acceptance material: PR 1 of section 19 turned
the table into the regression corpus `Adr0208NarrowingCorpusTests` (one test
per row, expected result per row, ADR-0154 witness per row), and later
findings add rows to the corpus, not rules to the design.

e20 contradicts ADR-0069's #712 addendum and `website/docs/ref/spec.md`,
which say a read-only top-level `let` narrows; the test
`Issue700SmartCastBinderTests.If_IsTest_OnGlobalVariable_DoesNotNarrow`
pins the rejection. This ADR does not change it; the documentation gap is
filed separately.

The three experiments that measured the deferred loop rule on the
compiler's own source (section 10) are recorded in the companion document
under "Experiments": whole-loop kill without a non-null proof, 12 errors in
one Core function; with today's bound proof, 0 errors; with every call also
killing closure-assigned and by-reference roots, 22 errors in three Core
functions; 0 errors in Core.Tests and gsc in every case.

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
binder knew when it produced that tree. The frame stack and the
structured-branch side tables `PendingEarlyExitFrames` and
`PendingSwitchExitFrames` are artifacts of the stack design and are deleted.
The jump-related state (`AssignmentNarrowingGenerations`, the proof
generations, `GotoNarrowingSnapshot`, `BackwardGotoNarrowingStates`) is
also an artifact of that design, but the retained backward-jump checker
reads it (`BinderContext.gs:798-800`), so it stays until the follow-up ADR
of section 10 replaces that checker; under the recorded scope it is fed
from the state value instead of from frames.

`NarrowingState` is immutable. Operations return a new value; a branch keeps
a reference to the state it started from and cannot disturb the other
branch. States are small (a handful of entries) and most statements leave the
state untouched, so the representation is an ordered immutable array of
`(path, type)` entries with copy-on-write; equality is structural.

**The invariant.** A fact is in the state at a program point only if it holds
on every control-flow edge that reaches that point: fall-through, structured
branches, `break`/`continue`/`return`/`throw`/`goto` edges (through the
cleanup regions they leave), the exceptional edge from every point inside a
`try` block, catch filter or catch body into the handlers and the `finally`,
writes through an alias of the storage (a `ref`/`out` parameter, a `ref`
local and the root of its initializer, a pointer), and writes performed by
code a call can run: a closure of the function that assigns the root, a
callable passed as an argument, a callable stored in a variable, a
caller-supplied callback that writes the caller's variable behind a
`ref`/`out` parameter, or any function at all for a mutable global. Two
more things follow from "every edge": a `when` filter of an enclosing
`try` runs in the first pass, before an intervening `finally` runs, so it
is an incoming edge of that `finally`; and a name resolved at a region's
entry may be shadowed by a declaration inside the region, so every
syntactic proof resolves names with the same scope-aware walk. Every rule
in sections 8 to 11 is derived from this invariant, and a rule that cannot be derived from it is wrong, whatever
shape it happens to accept. Where a rule has to approximate, it approximates
toward fewer facts.

**The region lower bound.** Binding is sequential, so a construct whose
entry state depends on code the binder has not bound yet (a loop back edge,
a backward `goto`, an exceptional edge into a handler) cannot be given its
exact entry state. It is given a sound lower bound instead. For a region of
statements `R` whose every entry edge carries a state at least `S`:

> `Lower(S, R) = S` with every path removed whose root `R` may assign, every
> member-bearing path removed when `R` contains a call or a member, index or
> indirect write, and every path on an aliased root removed when `R` writes
> through an alias (the alias class below).

A fact in `Lower(S, R)` is about storage that no statement in `R` changes,
so it holds on every edge entering `R` and at every point inside `R`,
including the edge after any statement that throws and the state at any
jump out of `R`. Binding `R` under `Lower(S, R)`, and binding any handler
or label whose incoming edges all come from `R` or from `R`'s entries under
`Lower(S, R)`, therefore satisfies the invariant without iteration and
without binding anything twice. "May assign" is computed from syntax before
`R` is bound (section 10) for loops and backward-`goto` regions, and from the
bound effects (section 13) for `try` statements, whose handlers are bound
after the protected block. Facts proven inside `R` (a guard, a condition, a
narrowing assignment) are added on top of the lower bound at the point they
are proven and flow forward as usual.

**The indirect-write class.** Some storage can be written by code that does
not name it at the write site. Any call in a region may write all of it, so
the lower bound removes every fact on it when the region contains a call:
mutable globals (top-level `var`; any function may assign one), locals in
the function's closure-assigned set (`ComputeClosureAssignedNames`), and
the alias class: `ref`/`out`/`in` parameters, `ref` locals together with
the roots of their initializers, and roots whose name appears under `&`,
`ref` or `out` anywhere in the function. A write to any member of the alias
class also kills every fact on the class, in straight-line code as well as
in a region, because the members may name one storage location. A member
of the alias class may also alias storage that no root names: a `ref` local
whose initializer is not a plain variable (`let ref a = xs[0]`, `let ref a
= box.Field`), and every `ref`/`out`/`in` parameter, whose caller may have
passed an element or a member (`Run(ref xs[0], xs)`). So every member,
index or indirect write kills every fact on the whole alias class,
parameters included (probe f2: `xs[0] = nil; a.Value` through a `ref`
local, and probe g2: the same through a `ref` parameter, both compile and
throw today; bug #5171, second and fourth shapes). The rule does not try to
tell which members of the class the write can reach.

**When a call kills by-reference facts (amendment A3, #5292).** A plain
call does not kill the fact of a by-reference parameter, or of a `ref` local
that aliases one, and neither does a read-only call, a call in a loop body,
or a call that passes another variable by `ref`/`out` (`Use(path); Use(path)`,
or `TryGetValue(path, out found)` in a loop, the shape of the translated
compiler source). This is the behavior of 0.5.212 and of C# nullable
analysis. The fact still dies on:

- a direct write to a member of the alias class (the assignment rules above);
- a member, index or indirect write, and user code that the table lists
  (computed getters, constructors with user code, callables of unknown
  origin, loop headers), which keep the full class kill;
- a call, for a `ref` local that does not alias a by-reference parameter (a
  `ref` local of an element or member, or of a mutable global), as before;
- a variable that one call passes more than once with at least one
  `ref`/`out` (`Run(ref b, ref b)`, or `ref b` together with `b`): the
  aliasing is visible at the call site, so the write is a write through
  every by-reference parameter.

A variable that a call passes by `ref`/`out` once does not kill the facts of
the other by-reference parameters; only an overlapping `ref` alias chain
does. Two by-reference parameters are treated as different storages in a direct
write only when that is provable: both types are plain named reference
types that are not generic and mention no type parameter (a source class, or
an imported class, interface or `object`), or primitives or strings, after
the outer nullability is stripped, and they are different types (`Run(ref
path AccessPath?, ref found TypeSymbol?)`, `Run(ref symbol ISymbol?, ref name
string?)`). A by-reference argument has the exact type of its parameter, so
a different reference type is a different storage. Everything else overlaps:
equal types, any generic instantiation (annotations nested in a construction
are not told apart: `Box[C]?` and `Box[C?]?`), tuples, structs and other
value aggregates (they embed the other as a member), arrays, source
interfaces, type parameters (also nested in tuples, maps, function types or
enclosing-type arguments, as `TypeSymbol.ContainsTypeParameter` decides), a nested type of a generic outer type (`Outer[string].Inner` and
`Outer[string?].Inner`) and any type that cannot be classified. The occurrences of a
variable among the receiver and the arguments of a call are collected
through conversions, null assertions, address-of operands and each branch of
a conditional (`Clear(ref b, b!!)`, `Clear2(ref flag ? b : b, ref b)`); an
operand counts a variable once, because the branches of one conditional are
mutually exclusive (`Touch(ref flag ? b : b)` is one reference). Each variable is
resolved to the storage it names before it is counted: through `let ref`
alias chains, on both the recording and the lookup side (`let ref c = b;
Clear2(ref c, ref c)`) (`let ref c = b; Clear2(ref b, ref c)`) and through the synthetic
capture that a null-conditional call uses as its receiver (`b?.Clear(ref
b)`). A conditional address handed to a `ref`/`out` parameter of an
imported method (as `RefCapabilities.GetParameterRefKind` decides, so
`[In, Out] ref` is writable) is a write; one handed to an `in` parameter is a read
(`Touch(in flag ? x : x)` keeps the fact, like `Touch(in x)`). The exemption is for plain
function and method calls only: a property or indexer accessor call (a
source indexer setter, `box[0] = 1`) keeps the full storage invalidation.

**Known limitations of the call rule.** Because a plain call does not kill
the fact, the rule does not cover a callee that writes the storage by a path
the call site does not show: (1) a mutable global or static that the
by-reference parameter aliases (`Run(ref g)`, then `Clear()` assigns `g`);
(2) an alias created elsewhere (the caller passed an element or member, and
a callee reaches its container through an array, list, `StrongBox`, a
cyclic object, a base class or a subclass, a generic holder, a
`CollectionsMarshal` slot, `LinkedListNode<T>.ValueRef`, `Memory<T>.Span`);
(3) a container reachable from an operand (`Clear(xs)` with the aliased
element in `xs`). They are the same hole as in C# nullable analysis and are
pinned as accepted programs by corpus rows h2 and h3 (they run and throw
`NullReferenceException`). A sound call-effect model is tracked in the
follow-up issue (effect summaries) tracked in #5326.

**The conservative default.** The lists above and the proof rules of
section 8 are closed. A fact survives a program point only when one of the
listed proof rules shows that it does; a construct, statement kind, call,
storage form or exception edge that no rule covers kills every fact on the
indirect-write class and every member-bearing path, never the reverse. In
particular every bound node kind has an entry in the construct table of
section 8, and the entry of a kind the table does not list is "call": the
implementation cannot add a node kind without deciding its effect, because
a test enumerates the kinds against the table (the repository already has
`BoundNodeKindExhaustivenessTests` for the same purpose elsewhere). This is
how the design absorbs a construct whose effects appear only after
lowering (probe f5: a `for ... in` over an iterator runs the iterator's
body inside `MoveNext`, which assigns a global; the bound statement's
children contain no call).

**Join.** A join is an operation over the whole set of incoming states of a
merge point, never a fold of binary joins: `Join(S1, ..., Sn)` is computed
once from all `n` predecessors (in source order, for determinism), and
`JoinJumps` hands the join the fall-through state and every recorded state
of a label in that one operation; the fall-through state is one predecessor
among the others, never joined afterwards with an already reduced result. For a
path present in every incoming state, with incoming types `T1 ... Tn`, the
join keeps the one `Ti` to which every other `Tj` converts by identity or an
implicit reference conversion (`Dog` and `Animal` join to `Animal`; `T` and
`T?` do not join, because `T?` is not a fact). When no such `Ti` exists, the
join keeps the path's declared type with one nullable layer removed: the
root's declared type for a plain root, the last link's declared type for a
stable member path. Every fact is a non-null refinement of the storage's
declared type and a read of the storage at its declared type needs no cast,
so this holds for any mix of incoming facts (`Dog` and `Cat` on `x Animal?`
join to `Animal`; `IInit` and `T` on `settings T?` join to `T`, which is
what `if settings is IInit init { ... }` yields when `T` does not implement
`IInit`). A path is dropped only when some incoming state has no fact for
it. This is amendment A1 (section 19a, #5206, accepted 2026-10-23): the
fallback as first written required every incoming type to convert to the
declared type with its representation preserved and applied to plain roots
only, which dropped `settings -> T` at two sites of the pinned Oahu inputs
(`SettingsManager.gs:51, 111`) that today's compiler keeps. A binary fold
would lose this: for `x object?` with incoming `Dog`, `Cat` and `Animal`,
`Join(Dog, Cat)` is `object` and `Join(object, Animal)` is `object`, while
the n-ary join keeps `Animal` (probe g1). This is the rule the `goto` join
already uses (ADR-0069 #4989 addendum, `FindCommonImplicitSupertype`,
`StatementBinder.Narrowing.gs:3860-3885`, over all incoming snapshots),
with its declared-root fallback widened by A1, applied to every merge; PR 1
made both call one function, `NarrowingState.JoinTypes`. It never computes
a least common supertype of unrelated types. It keeps an outer
non-null proof when an inner branch strengthens it (`if x != nil { if x is
Dog { } return x.Name }`: `x -> Dog` and `x -> Animal` join to `x ->
Animal`, probe d5) and when sibling branches refine it differently (probe
f1, rejected today at a branch join and accepted after, row R1). The
external-callable alias set joins by intersection.

**Reachability.** The state carries reachability separately from facts.
`Unreachable` is the identity of `Join`. A jump from an unreachable point,
or a jump that must pass through a cleanup region whose cleanup cannot
complete normally, records no edge. Statements at an unreachable point are
still bound, for diagnostics, under the facts in force where the dead
stretch begins, and nothing they do (writes, jumps, proofs) reaches the
state of any reachable point. This is today's behaviour
(`ReachableUserLabels`, `DeferredUnreachableGotoEdges`, and the
`Unreachable{Forward,Backward}Goto_DoesNotInvalidateReachableNarrowing`
tests), stated as a rule; probe d6 depends on it.

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
    func KillRoots(roots IReadOnlyCollection[VariableSymbol]) NarrowingState

    /// Merge over ALL predecessors of a merge point at once. The type rule
    /// is defined once, in section 6 ("Join", as amended by A1), and
    /// implemented once, in NarrowingState.JoinTypes; this comment does not
    /// restate it. Aliases intersect. Unreachable predecessors are skipped
    /// (identity). Callers never fold this pairwise: Join([Dog, Cat,
    /// Animal]) on `x object?` is Animal, while Join(Join(Dog, Cat),
    /// Animal) would be object.
    static func Join(predecessors IReadOnlyList[NarrowingState]) NarrowingState
    /// The genuine two-way case (an `if` without jumps into its join, `?:`,
    /// `??`): Join([this, other]).
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
    /// The entry state of a label: ONE n-ary Join over the fall-through
    /// state (Unreachable when the label is not reached by fall-through)
    /// and every state recorded for the target, in source order, after the
    /// pending cleanup transfers have been applied to each recorded state.
    /// The recorded states are never pre-reduced among themselves.
    func JoinJumps(target BoundLabel, fallThrough NarrowingState) NarrowingState
    /// The roots the `when` filters of this function may write (section 9),
    /// computed once per function from syntax. The follow-up ADR of
    /// section 10 would generalise this to loop and backward-goto regions.
    func FilterWrites(scope BoundScope) FilterWriteSet
}
```

### 8. Transfer functions: the closed proof list and the construct table

The state changes at these points, in evaluation order, inside expressions
as well as between statements. Facts enter the state only through the
proof rules below; facts leave it through the construct table. Both lists
are closed: a construct or situation that is on neither list kills.

**Proof rules (the only ways a fact enters or survives a point):**

- **P1 Condition.** A condition classified by the existing classifiers
  (`TryClassifyNilGuard`, `TryClassifyBoolCallNarrowing`,
  `TryClassifyTypeTestNarrowing`, `ClassifyIfConditionNarrowing` at
  `StatementBinder.Conditionals.gs:25-44`) yields a then-state and an
  else-state. `!` swaps them; `&&` binds the right operand under the left
  then-state and intersects else-states; `||` is the dual; `??`, `?:` and
  the `if` expression use the same classification (ADR-0064 #4964
  addendum). Unchanged.
- **P2 Assignment.** `x = value` where `TryClassifyNonNullAssignment` holds
  (`:1145-1175`) adds `x` at its declared type with one nullable layer
  removed (ADR-0069 #4989 addendum: never the assigned class). Unchanged.
- **P3 Post-condition.** A call statement whose callee carries
  `[MemberNotNull]` adds the named implicit fields
  (`ApplyMemberNotNullNarrowings`). Unchanged.
- **P4 Bindings.** Pattern variables and `if let`/`guard let`/`while let`
  bindings keep their scoping rules (ADR-0166, ADR-0201); they are scope
  facts, not state facts. Unchanged.
- **P5 Join.** As defined in section 6 ("Join", as amended by A1), the one
  definition of the join type rule in this document; `NarrowingState.
  JoinTypes` is its one implementation. Not restated here.
- **P6 Region lower bound.** As defined in section 6, for loops, backward
  jumps and handlers, with the kill sets computed from the construct table
  (bound effects where the region is already bound, the syntactic walker of
  section 10 where it is not).
- **P7 Syntactic non-null value, in region kill sets only.** An assignment
  to an exact-storage root (`IsAssignmentNarrowingRoot`) keeps the facts its
  right side proves syntactically: a non-nil literal of a reference type; a
  construction `T(...)`/`T{...}` where `T`, resolved by the scope-aware walk
  at the assignment site, names a **reference type** (class, interface,
  delegate, function type) and no variable or function, and the target's
  declared type is that type or one it converts to by an implicit
  reference conversion; or `value!!` (nullability only). A value-type
  construction is not proof, because the assignment may box it and
  `System.Nullable[int32]()` boxes to nil (probe f4, rejected today and
  after); a user-defined or unknown conversion at the assignment is not
  proof. Everything else kills. Under the recorded scope this rule is used
  only by the follow-up ADR's loop kill set (section 10); it is listed here
  so that the proof list stays closed when that ADR lands.
- **P8 Closure entry.** A closure body starts from the enclosing state
  restricted to plain-variable, `IsReadOnly` roots (ADR-0069 #2442 rule).
  Unchanged.

**Construct table (how a bound node changes the state).** Each bound node
kind has one effect class. The implementation keeps the full table beside
the walkers and a test enumerates every `BoundNode` subtype in the
assembly against it, like `BoundNodeKindExhaustivenessTests` does for the
rewriters; a kind that is absent from the table has the effect `call`. The
table covers every concrete `BoundNode` type in the assembly (102 at PR 1,
`NarrowingConstructTable`, including the post-lowering kinds, which are
`call`), checked by a test in both directions. The table gives one class
per type; where a type carries two effects that the type alone does not
decide (`BoundConversionExpression` with or without a user-defined
conversion, `BoundPropertyAssignmentExpression` with or without a setter
body, a `BoundBinaryExpression` that is `&&`/`||`/`??` or a plain operator,
`BoundDereferenceExpression` as a target or a read) the table gives the
more destructive class and a binder-side refinement is a later table
change, not a rule change. Names below that are not classes (cleanup
regions, `break`/`continue`) describe the lowered shape the listed class
covers. The classes, with representative kinds:

| Effect class | Kinds (representative) | Effect on the state |
| --- | --- | --- |
| `none` | `BoundVariableExpression`, `BoundLiteralExpression`, `BoundDefaultExpression`, `BoundTypeOfExpression`, `BoundSizeOfExpression`, `BoundLenExpression`, `BoundTupleElementAccessExpression`, `BoundIsExpression`/`BoundAsExpression` without user code, `BoundTypePattern`, `BoundDiscardPattern`, `BoundLabelStatement`, `BoundAwaitSequencePoint`, `BoundLocalFunctionDeclaration`, `BoundErrorExpression` | children only |
| `root-write` | `BoundAssignmentExpression`, `BoundVariableDeclaration` with an initializer, deconstruction targets, `out`/`ref` arguments, `++`/`--` on a name | removes every path on the root; if the root is in the alias class, every fact on the class; applies P2 afterwards |
| `member-write` | `BoundFieldAssignmentExpression`, `BoundPropertyAssignmentExpression`, `BoundIndexAssignmentExpression`, `BoundClrIndexAssignmentExpression`, `BoundClrPropertyAssignmentExpression`, `BoundIndirectAssignmentExpression` through an address-of operand | removes every member-bearing path and every fact on the alias class (a `ref` local or a by-reference parameter may alias the written element or member: probes f2, g2); a property setter with user code is also `call` |
| `pointer-write` | `BoundIndirectAssignmentExpression` through anything else, `BoundDereferenceExpression` as a target | removes every mutable root (`MayMutateAnyRootViaPointer`) |
| `alias` | `BoundAddressOfExpression`, `BoundConditionalAddressExpression` (both operands, whichever the condition selects; its condition and operands flow like `?:`), `BoundManagedReferenceExpression`, `BoundFixedStatement`, `BoundStackAllocExpression`, a `ref` local declaration | puts the operand's root (every operand's root, for a conditional address) in the alias class; the write rules above then apply to the class |
| `call` | `BoundCallOperationExpression`, `BoundIndirectCallExpression`, `BoundFunctionPointerInvocationExpression`, `BoundConstructorCallExpression`, `BoundClrConstructorCallExpression`, `BoundTypeParameterConstructionExpression`, `BoundStructLiteralExpression` (field initializers), `BoundBaseClassCallExpression`, `BoundConstructorChainingExpression`, `BoundClrConversionCallExpression`, `BoundConversionExpression` with a user-defined conversion, `BoundBinaryOperationExpression`/`BoundUnaryExpression`/`BoundClrUnaryOperatorExpression` on user-defined operators, `BoundEventSubscriptionExpression`, `BoundClrEventSubscriptionExpression`, `BoundInterpolatedStringExpression` (`ToString`), `BoundAwaitExpression` (awaiter calls), `BoundForRangeStatement`/`BoundAwaitForRangeStatement` (`GetEnumerator`, `MoveNext`, `Current`, disposal; probe f5), `using`/`await using`/`lock`/`defer` cleanup regions (disposal, `Monitor`), `BoundGoStatement`, `BoundYieldStatement` (the consumer runs arbitrary code before resumption), property reads with user code (a non-auto getter; in any position, a condition included: row R14 and amendment A2, #5215) and `BoundPropertyPattern`/`BoundListPattern`/`BoundSlicePattern`/`BoundConstantPattern`/`BoundRelationalPattern` that invoke user code, `BoundMethodReferenceOperationExpression`/`BoundPropertyReferenceOperationExpression` when invoked, **and every kind not in the table** | removes every member-bearing path and every fact on the indirect-write class (mutable globals, closure-assigned locals, the alias class; row R15), except that a plain `BoundCallOperationExpression` does not kill the fact of a by-reference parameter unless the call passes one variable more than once with a `ref`/`out` (amendment A3, #5292: `Use(path)` and `TryGetValue(path, out found)` keep the fact); in straight-line code with a bound callee, today's finer classification may keep mutable globals only when the callee is a declared function proven not to assign them, which this ADR does not define, so globals are always removed |
| `jump` | `BoundReturnStatement`, `BoundThrowStatement`, `BoundRethrowStatement`, `BoundThrowExpression`, `BoundGotoStatement`, `break`/`continue` | one successor: records the state on the target (through pending cleanup) and yields `Unreachable` |
| `conditional-jump` | `BoundConditionalGotoStatement` (the binder emits it before the then-body of a multi-clause `if let`, `StatementBinder.Conditionals.gs:299-305`, and the CFG connects both successors, `ControlFlowGraph.gs:298-314`) | two successors: binds the condition and applies its effects (P1 classification plus the condition's own writes and calls); records `Assume(condition, JumpIfTrue)` on the target through pending cleanup; continues with `Assume(condition, !JumpIfTrue)` as the fall-through state. It never yields `Unreachable` by itself. The rule this row fixes: no kind with a live fall-through successor may use the `jump` class, whose transfer ends the current path. A kind that selects between two operands or branches gets its control flow from the join rules (P1 on the condition, each operand under its derived state, P5 on their exits), whatever effect class names its other effect: statement-level branching is `join` or `region`, and an expression such as `BoundConditionalAddressExpression` keeps its `alias` class for the operands it may select while its two operands are joined like those of `?:` |
| `join` | `BoundIfStatement`, `BoundConditionalExpression`, `BoundSwitchExpression`, `BoundPatternSwitchStatement`, `BoundNullConditionalAccessExpression`, `&&`/`||`/`??`, `BoundTryStatement` exits, labels | P1 on the condition, children under the derived states, P5 on the exits |
| `region` | loops (`BoundLoopStatement` subtypes), the backward-jump region, `BoundTryStatement` handlers and `finally` | P6; the region's own effects are the union of its children's effects plus the `call` effect when the table says the construct introduces calls |
| `closure` | `BoundFunctionLiteralExpression` | P8 for the body; the literal's own creation has no effect; the body's assignments are in the closure-assigned set |

Two consequences of the default: a kind added to the compiler later is
`call` until someone decides otherwise, and a review finding of the form
"construct X also runs user code" is a table entry, not a design change.
The external-callable alias set is a fact like any other: it is removed
when its variable is assigned and it never exempts the alias class or
globals.
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
- `switch`: dispatch is a chain, and the state threads through it in
  evaluation order. The dispatch state before arm 1 is the state after the
  discriminator; arm i's pattern test and `when` guard are bound under the
  dispatch state before arm i; the arm body is bound under that state plus
  the arm's facts; the dispatch state before arm i+1 is the state before arm
  i with the effects of arm i's pattern test and guard applied (a guard that
  writes through `ref` or calls kills, whether it then succeeds or fails).
  The exit state joins the exits of the arms that complete normally and, when
  the switch is not exhaustive, the dispatch state after the last arm (the
  "no arm matched" path), never the entry state. `switch 1 { case 1 when
  Clear(ref s) { return 0 } }; s.Length` with `Clear` storing nil and
  returning false is rejected today and stays rejected (probe g3); joining
  the entry state would have accepted it. The same threading applies to
  `else if` chains (each condition is bound under the previous condition's
  else-state, effects included) and to the `switch` expression. Today's rule
  that every non-exiting arm must contribute the same discriminator
  narrowing (ADR-0069 #712) is exactly this join.
- A block's exit state flows to the statement after the block. A block no
  longer pops a frame; the scope ends, the facts about outer variables do
  not.
- `try { T } catch when (f) { C } finally { F }`, with entry state `S`:
  - Every point in `T` can throw, and a `when` filter can run (and write,
    through a `ref` argument or a callback) before any handler of any
    enclosed or sibling `try` runs: an earlier clause's filter before a
    later clause (probe cA), an enclosing filter before an intervening
    `finally` (probe d1), and an enclosing filter before an inner `catch`
    when a nested `finally` throws a replacement exception after the first
    pass has run the outer filter (probe f3: `try { try { try { throw f }
    finally { throw g } } catch (InvalidOperationException) { s.Length } }
    catch (FormatException) when Clear(ref s) { }`). All three compile today
    and dereference nil (bug #5168). The rule therefore does not reason
    about handler order: **every handler entry, catch or finally, is bound
    under `Lower(S, T ∪ every when filter in the function)`**, where the
    filters' effects come from the syntactic walker of section 10 because
    filters of enclosing statements are bound later. A clause's body is
    bound under that state with its own filter's effects applied (today
    only the alias effects are applied, `ApplyHeaderCallableEffects`).
    Functions without `when` filters, the common case, lose nothing.
  - Every point in `T`, in every filter and in every catch body can throw or
    jump into `F`, and `F` is bound before the pending jumps out of the
    statement are released. A throw out of `T` that no clause of this `try`
    handles also runs the `when` filters of every enclosing `try` in the
    first pass, before `F` runs in the second pass
    (`Adr0177CatchClauseParityTests.Filter_RunsInTheFirstPassBeforeAnInterveningFinally`).
    So the finally entry state is `Lower(S, T ∪ own catch bodies ∪ every
    when filter in the function)`. Probe d1 (outer
    `catch when Clear(ref s)`, inner `finally { Consume(s.Length) }`)
    compiles today and dereferences nil inside the finally, masked by the
    same handler (bug #5168, second shape); this rule rejects it (row R10).
    The normal exits of `T`
    and of the catch bodies are not used for `F`'s entry, because an
    exceptional or jump edge can enter `F` from a point whose state has fewer
    facts than any normal exit, and because a catch body that assigns and
    then returns has no normal exit at all while its write still reaches
    `F`. `try { throw } catch { s = nil; return 0 } finally { s.Length }`
    stays rejected (probe c1 in section 4).
  - The statement's exit state is `F`'s exit transfer (kill `F`'s effects,
    add `F`'s normal-exit facts) applied to the join of the normal exits of
    `T` and of the catch bodies; `Unreachable` when `F` cannot complete.
  - `defer` and `using` cleanup regions are the same shape with an empty
    handler list.
- An unconditional jump (`break`, `continue`, `return`, `throw`, `goto`)
  records its state on the target and yields `Unreachable`. A conditional
  jump (`BoundConditionalGotoStatement`, which the `if let` lowering emits
  before its then-body) has two live successors: after the condition's own
  effects, the taken state (`Assume(condition, JumpIfTrue)`) is recorded on
  the target and the not-taken state (`Assume(condition, !JumpIfTrue)`)
  flows on to the next statement; it never yields `Unreachable` by itself,
  and its not-taken writes and exit state take part in later joins like
  any other statement's. A jump that leaves cleanup regions
  is recorded with the regions still to run; when a region's cleanup has
  been bound (under the lower bound above, which is at most the state of any
  such jump), its exit transfer is applied to each pending state before the
  target joins it. This keeps the `GotoLeavingTry_*` and `*Finally*` results
  of `Issue4519GotoAssignmentNarrowingTests`.
- A user label (and every synthesized label: `break`/`continue` targets,
  loop exits, the `if let` else and end labels) is one n-ary join over the
  fall-through state and every recorded jump state, computed by
  `JoinJumps(target, fallThrough)` in one operation; the recorded states
  are not reduced among themselves first, and the fall-through state is not
  joined afterwards with a reduced result (section 6). Forward `goto` keeps
  its join rule, including the one-incoming-type-converts-to-the-others
  rule of the #4989 addendum (`FindCommonImplicitSupertype`); the
  predecessor list is in source order.

### 10. Loops and backward jumps: unchanged mechanism, deferred redesign

Under the recorded decision (section 18a), loops and backward `goto` keep
today's mechanism. `BindLoopBody` binds the body, collects the writes that
reach the back edge and binds the body a second time when an inherited fact
is invalidated (`StatementBinder.Jumps.gs:241-414`,
`CollectLoopBackEdgeMutations` at `StatementBinder.Narrowing.gs:556-606`);
backward jumps keep `BackwardGotoNarrowingStates`, the proof generations and
the deferred re-report (`BinderContext.gs:695-960`,
`StatementBinder.Narrowing.gs:853-918`). Two things change inside that
mechanism because they follow from sections 6 and 8, not from the loop
design: the collectors read the `NarrowingState` value instead of the frame
list, and they apply the construct table's effects, so a call inside a loop
or a backward-jump region kills facts on mutable globals (R11) and a write
to an alias-class member kills the class (R12), as in straight-line code.
Nothing else about loop or backward-jump narrowing changes; ADR-0069's
#2943 addendum stays their semantics reference, and the loop-related
irregularities listed in section 2 remain until the follow-up.

The redesign that binds a loop body once under a syntactic kill set (the
region lower bound of section 6 applied to loops and to a backward-jump
region, with scope-aware name resolution, a reference-type construction
proof and the construct table applied to syntax) was drafted and reviewed in
this document up to commit 001ee4ff5 of PR #5164 and is deferred to a
follow-up ADR. That ADR starts from a measured spike: the
`narrowing.loop-rebinds` counter that PR 1 adds, run on Core, Core.Tests and
Oahu (how often the second bind happens today); the comparison-mode report
of the syntactic kill set against the bound back-edge analysis on the same
inputs (what the kill set loses in real code: the draft's three experiments
in section 4 measured four functions in `src/Core` and none in Core.Tests or
gsc); and the walker's syntax-kind enumeration test. The probe rows of
section 4 that exercise loops and backward jumps (e2b, e3, e4, e13, e15,
e16, e18, c2 to c8b, cB, cC, d2, d3, d4, d6, f4, f5) stay in the regression
corpus with their results under the unchanged mechanism, except where R11
and R12 change them.

The one piece of the draft this ADR keeps is the syntactic scan that
section 9 needs for `when` filters, which are bound after the handlers that
must see their effects: a function-wide walk of the filter expressions that
applies the construct table to syntax (a name under `ref`, `out` or `&` is a
root write of the variable it resolves to at the filter's scope, any call
is `call`, an unknown syntax kind is `call`), computed once per function and
cached. Its result is the filter contribution to every handler's
`Lower(S, ...)` in section 9.

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
stays the owner of `GS0100`. What an unreachable point does to the rest of
the flow (nothing) and how dead code is bound (under the facts in force) is
the reachability rule of section 6.

### 13. Effects: computed once, composed bottom-up

`StatementEffects` is an immutable record: assigned roots (ordered by
declaration order), writable-reference roots, and the flags
`MayMutateMemberPaths`, `MayMutateAnyRoot`, `MayMutateAnyRootViaPointer`,
`MayMutateGlobalRoots`, plus the callable-alias deltas. A compound
statement's effects are the union of its children's; a block's effects are
the union of its statements'. The binder records a node's effects in a side
table keyed by the bound statement when it finishes binding that statement,
so every node is visited once over the whole body instead of once per
enclosing block. The record holds raw sets and flags only; the answer that
depends on the alias set at the statement's entry
(`DefinitelyExternalFunctionValues`) is derived at the use site from the
record and the entry state, not stored. A statement that contains a
function literal is walked, not composed, because the collector analyses a
closure's body at the sites that invoke it. This is where #5152's
single-entry cache (`effectsNode`/`effects`, `:29-31`) becomes a table; the
counter `narrowing.effect-walks` becomes equal to the statement count only
when the callable-alias analysis is also made bottom-up, which PR 2 does
when it folds the alias set into the state (PR 1 left the production path
on the #5152 cache: 95,127 walks on Core, unchanged, while its comparison
mode composed 92,577 statements from 50,010 reused child records with 2,042
walked for function literals and 0 differences from a full walk).

Caching and invalidation of the query itself are trivial: `NarrowedType` is
a lookup in a small immutable array; there is no cache to invalidate because
each state is a value tied to one program point. The expensive things today,
the re-walks, do not exist in this model. The one piece of pre-bind work
under the recorded scope is the function-wide `when`-filter write scan of
section 9: a syntax walk over the filter expressions of the function,
applying the construct table to syntax with name resolution at each
filter's scope, computed once per function (and only for functions that
have a `when` filter) and consumed by every handler entry; it is not
conditional on active narrowings. The loop and backward-jump walks of
today's mechanism (`CollectLoopBackEdgeMutations` and its per-loop lowering
and CFG, the backward-`goto` snapshots) are retained as section 10 says,
reading the state value; the follow-up ADR decides whether a pre-bind loop
kill set replaces them. Today's `HasActiveNarrowings` guard (`:519`) keeps
its role for the retained loop walk.

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
  1. **Less permissive rows** (section 16) can reject repository source.
     Under the recorded scope the less permissive rows are R9 to R14. R9 to
     R13 reject nothing in `src/Core` (no `when` filter writes a narrowed
     root, no top-level `var`, no `ref` local, no suspension point reading
     a closure-assigned local was found by PR 1). R14 rejects two sites,
     which the pin-move PR restructures by reading the property into a
     `let` before the guard:
     `src/Core/CodeAnalysis/Binding/ExpressionBinder.Access.MemberLookup.gs:3991`
     and `src/Core/CodeAnalysis/Lowering/BaseCallForwarderRewriter.gs:490`
     (section 19a, A2). The measurements in section 4 also found four
     functions that the draft's loop rule (deferred) would reject:
     `ExpressionBinder.Assignments.gs:5435-5494` (reassignment from a
     pattern variable), `BinderContext.gs:906-923` (an `out` parameter read
     in a loop with a call) and `MemberLookup.gs:1108-1120`, `:3100-3172`
     (locals a closure in the same function assigns, read in loops with
     calls); they are the follow-up ADR's concern. Every such restructuring
     must be a restructuring, not `!!`: under the pin, the pinned compiler
     proves the value non-null there and reports `GS0536`, and warnings are
     errors, so `!!` cannot bridge the two compilers. The implementation PRs
     compile Core, Core.Tests and gsc with the built compiler (the
     response-file procedure in the References section) to confirm the
     list.
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
| R1 | (a) Then-branch fact survives when the else-branch exits: `if s != nil { A } else { return }` then `s.Length` (e8); `if b.Pet is Dog { } else { return }` then `b.Pet.Bark()` (e7/Run2); sibling refinements join to the declared non-null type (f1). (b) Output change in accepted programs: a type-test fact that now survives a join selects a hidden member on the narrowed type where today's read selected it on the declared type: `if x is Dog { } else { return "" }; return x.Name` prints `animal` today and `dog` after (f6). (c) Accepted-to-rejected: a type-test fact that now survives a join makes an overload call ambiguous: `x IA`, `class Both : IA, IB`, `Take(IA)`/`Take(IB)`; `if x is Both { } else { return }; Take(x)` selects `Take(IA)` today and reports GS0266 after (g4; `Issue1154NullableWideningOverloadTests.GenuineAmbiguity_StillReportsGS0266` pins the ambiguity for a `Both` argument) | (a) GS0158 / GS0159; (b) accepted; (c) accepted | (a) accepted; (b) accepted, different member selected; (c) GS0266 | (a) more permissive; (b) output change; (c) less permissive |
| R2 | Assignment in a branch that exits does not kill the fact after the `if`: guard, `if c { s = nil; return }`, then `s.Length` (e17) | GS0158 | accepted | more permissive |
| R3 | A fact lifted inside a nested bare block survives the block: `{ if s == nil { return } }` then `s.Length` (e10) | GS0158 | accepted | more permissive |
| R4 | Facts established in switch arms join after the switch: arms assign `s` non-null, `default` returns, then `s.Length` (e9); nested loops, `try`, labelled blocks inside branches contribute their exit state instead of `ClearAssignedRoots` | GS0158 | accepted | more permissive |
| R5 | Member paths and type-test facts take part in every join, not only in the early-exit lift; a `[NotNullWhen]`-derived member-path fact lifts past an early return like a nil-guard fact does (ADR-0069 #4216 addendum, second bullet) | GS0158 / GS0159 | accepted | more permissive |
| R6 | A user label or `goto` elsewhere in the function no longer disables lifts and joins: e5 (`goto` after an `if` join), e18/Run (guard, label, read, backward `goto`, no write) | GS0158 (#4285, #4290) | accepted | more permissive |
| R9 | Invalidation is expression-granular: `s != nil ? consume((s = nil), s.Length) : 0` (ADR-0064 L576-581, #4985) | accepted, dereferences nil at run time | GS0158 | less permissive (soundness) |
| R10 | Every handler entry sees the writes of every `when` filter in the function: a later clause (probe cA), an intervening `finally` (probe d1), an inner `catch` reached through a replacement exception (probe f3), where the filter stores nil (bug [#5168](https://github.com/DavidObando/gsharp/issues/5168)) | accepted, dereferences nil at run time | GS0158 | less permissive (soundness) |
| R11 | Any call, written or introduced by lowering, kills a fact on a mutable global: `text = "safe"; Clear(); text.Length` where `Clear` assigns the global (probes d3, d3b); `for item in items { }` over an iterator that assigns it (probe f5) (bug [#5170](https://github.com/DavidObando/gsharp/issues/5170)) | accepted, throws `NullReferenceException` at run time | GS0158 | less permissive (soundness) |
| R12 | A write to any member of an alias class kills the facts on the whole class, and so does any member, index or indirect write (a call alone does not kill a by-reference parameter's fact: amendment A3, #5292), because a `ref` local or a by-reference parameter may alias the written element or member: `let ref a C? = x; ...; x = nil; a.Value` (probes d4, d4b); `let ref a C? = xs[0]; ...; xs[0] = nil; a.Value` (probe f2); `Run(ref xs[0], xs)` with `Run(ref a C?, xs []C?)` doing `xs[0] = nil; a.Value` (probe g2) (bug [#5171](https://github.com/DavidObando/gsharp/issues/5171)) | accepted, throws `NullReferenceException` at run time | GS0158 | less permissive (soundness) |
| R13 | A suspension point (`await`, `yield`) kills facts on mutable globals and on closure-assigned locals, because the code that runs while the function is suspended may invoke a closure that escaped: iterator with `let clear = func() { s = nil }`, `if s != nil { yield 0; yield s.Length }` (probe g5) | accepted, prints `0` and `1` | GS0158 | less permissive (conservative default; the program is correct) |
| R14 | A read of a property with user code (a non-auto getter) is a `call` in every position, a condition included, and removes every member-bearing path: `if getResultCall.Receiver is not BoundImportedInstanceCallExpression getAwaiterCall { return }` after an earlier proof of a member path (`ExpressionBinder.Access.MemberLookup.gs:3991`, `BaseCallForwarderRewriter.gs:490`) | accepted (today's straight-line kill follows the statement's syntax: calls and member writes only) | GS0158 / GS0159 on the member-path read | less permissive |
| R15 | Any call, written or introduced by lowering, kills a fact on a closure-assigned local or parameter, because the callee can run a closure that escaped and assigns it. A declared function with no captures and no callable argument is no exception. A call through a callable value keeps today's classification (`AnalyzeCallableVariable`): `h.Callback = func() { x = nil }; if x == nil { return 0 }; Wrapper(h); x.Value` with `Wrapper(h Holder) { h.Callback() }` (probe q3, straight-line form; bug [#5237](https://github.com/DavidObando/gsharp/issues/5237)). A by-reference parameter keeps its fact (amendment A3), and a local that no closure assigns keeps its fact | accepted, throws `NullReferenceException` at run time | GS0158 | less permissive (soundness) |

Details per row:

- **R1-R4, R6.** These are consequences of one join rule (section 9). No new
  diagnostic; `GS0158`, `GS0159` and `GS0503` stop firing where the fact now
  holds. R1 (b) is an output change in accepted programs: wherever a
  type-test fact now survives a join and the read selects a member hidden
  on the narrowed type, the selection changes (f6). It applies under the
  recorded scope of section 18a, so it is in PR 2's parity exceptions with
  f6 as an emitted-output test, and open question 3 holds the decision; PR
  1's comparison mode reports every such site on Core, Core.Tests and Oahu
  first. Tests: `Issue2159IfJoinNarrowingTests` gains the else-exit and
  exiting-branch shapes; `Issue712FlowNarrowingExtensionsBinderTests` gains
  the arm-assignment shape; `Issue4285GotoNarrowingReachabilityTests` (14
  tests) are re-expected one by one: the bypass cases
  (`Goto_BypassesNilGuard_DoesNotNarrowFieldPath`, `*GuardLetElse*`,
  `*PatternVariableLeak*`) keep their rejection because the bypass path
  reaches the join without the fact; the cases that only assert "a `goto`
  elsewhere suppresses" flip to accepted. `Issue4519` forward-`goto` rows
  (`ForwardGoto_*`, `MultipleGotosToSameLabel_IntersectTheirNarrowingStates`,
  `ForwardGoto_JoinsFallthroughAndIncomingToCommonSupertype`) are joins and
  keep their results (the n-ary join of section 6 is the rule they already
  use; g1 is the three-predecessor case). Compatibility: a program that
  compiles today compiles after unless a type-test fact that newly survives
  a join changes a read's member selection (R1 (b)) or makes an overload
  call ambiguous (R1 (c), GS0266, the fix being an explicit conversion of
  the argument). The comparison mode reports every member-selection,
  overload and cast difference on Core, Core.Tests and Oahu before PR 2
  lands, and overload changes are part of its acceptance; `!!` written for
  these shapes becomes `GS0536` (section 15).
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
- **R7, R8 (deferred).** The draft's loop and backward-jump rows, with
  their test inventories (`Issue2943LoopBackEdgeNarrowingTests`, the 102
  `BackwardGoto_*` tests of `Issue4519GotoAssignmentNarrowingTests` by
  family), are in this document at commit 001ee4ff5 of PR #5164 and belong
  to the follow-up ADR of section 10. Under the recorded scope those tests
  keep today's expectations, except the loop forms of d3, d4, f5 and f2,
  which R11 and R12 reject.
- **R9.** New test with an ADR-0154 witness (red on today's compiler by
  running the program). Compatibility: the program is wrong today; the
  diagnostic is the fix. `a ??= b` narrowing afterwards (#4978) becomes
  expressible in the same model; whether to enable it is #4978's decision.
- **R10.** New test from probe cA with an ADR-0154 witness (today's
  compiler accepts it and the program throws). Compatibility: the program
  is wrong today; the diagnostic is the fix. ADR-0177's filter semantics
  (a false or throwing filter continues the handler search) is what makes
  the earlier filter's write reach the later clause. The defect in the
  current compiler is filed as #5168 (P1; d1 is its second shape); a
  narrower fix in the current scheme (invalidate the roots a filter writes
  before binding the remaining clauses and every finally it encloses) may
  land before this ADR, in which case R10 becomes a no-change row.
- **R11, R12.** New tests from probes d3, d3b, d4 and d4b with run-time
  witnesses on today's compiler. Both are defects in 0.5.212 (#5170,
  #5171) and may be fixed in the current scheme first, in which case the
  rows become no-change rows. `src/Core` has no top-level `var` and no
  `ref` local, so neither row touches the bootstrap.
  `ForwardGoto_FinallyDirectSourceCallInvalidatesGlobalNarrowing`
  (`Issue4519:5827-5850`) keeps its rejection.
- **R13.** The construct table (section 8) classifies `BoundAwaitExpression`
  and `BoundYieldStatement` as `call`. Today's collector inherits
  `BoundTreeWalker.VisitYieldStatement` and visits only the yielded
  expression, so g5 compiles and runs correctly: the closure never escapes.
  The conservative default kills anyway, because a closure that has escaped
  (stored in a field or a global, passed to an earlier call) can be invoked
  by the consumer or the continuation while the function is suspended, and
  the table does not track escapes. The precision refinement, "kill only
  when a closure of the function has escaped before the suspension point",
  is a table-level change the follow-up ADR or a later PR may make; it needs
  no new rule. Compatibility: iterator and async bodies that guard a local
  some closure assigns and read it across a suspension point get GS0158;
  the fix is to re-test after the suspension or to copy into a `let`. The
  response-file compile of PR 2 measures how many such sites `src/Core`,
  Core.Tests and gsc have (unknown at the time of writing; the earlier
  experiments did not exercise suspension points). g5 joins the corpus with
  a mutant witness (suspension classified `none`).
- **R14 (amendment A2, #5215, accepted 2026-10-23).** Found by PR 1's comparison
  mode: two sites in `src/Core` where a condition reads a non-auto property
  on a path an earlier guard narrowed. Today's straight-line invalidation
  (`SyntaxMayMutateMemberPaths`) kills member paths on calls and member
  writes only, so a getter with user code does not kill; today's loop
  collector and `finally` summaries do kill on it
  (`AssignedRootsCollector.VisitExpression`, `:1751-1753`), so today is
  inconsistent. The row keeps the construct table as written: a getter
  with user code is a call (ADR-0069 #1180: an intervening call
  invalidates member paths), and the condition's effects apply before its
  branches (section 9). Impact: Core 2 sites, Core.Tests 0, gsc 0, Oahu 0;
  the two Core sites are restructured (read the property into a `let`
  before the guard) in the pin-move PR, not with `!!` (section 15). The
  rejected alternatives are in section 19a. Tests: the two shapes with a
  mutant witness (property reads classed `none`).
- **R15 (#5237).** `AnalyzeCallableArguments` keeps a closure-assigned local
  across a call when the callee has no captures and receives no callable
  argument. A callee can still run a closure that an earlier statement
  stored in a field or a collection, so the exemption is unsound, not
  imprecise. The row uses the one rule of R11: the nodes of the construct
  table that run source code (`MayRunEscapedClosure`: declared calls,
  getters and constructors with user code, not a call through a callable
  value) also kill every fact on
  a plain local or parameter that a closure of the enclosing function can
  assign (`MayBeAssignedByClosure`), except a by-reference parameter or
  local (A3, R12). `StatementBinder.MayBeMutatedByEscapedClosure` is the
  one definition, and the loop collector and `NarrowingState.Kill` read it,
  so the loop form of the probe (ADR-0213 q3) closes with it. The syntactic
  exemption of open question 7 stays deferred to #5196. Issue #5483 completes the
  construction classification: `StatementBinder.ConstructionRunsUserCode` is
  the one definition that R11 and R15 read. A class whose declaration has a
  `shared { init { ... } }` block, or whose base class has one, runs user code
  at its first construction (the `.cctor` is not `beforefieldinit`). A value
  type literal is `initobj` and does not run it, and a type with only `shared`
  field initializers is `beforefieldinit`, so neither counts. The check reads
  the declaration, not the bound block, so the answer does not depend on
  which body binds first. Corpus rows r1 to r10 (issue #5483). Tests: the probe
  q3 with a mutant witness (the predicate returns false), and a root that
  no closure assigns keeps its fact.
- **Join of strengthened facts (no row).** Probe d5 is accepted today and
  after; the join definition in section 6 keeps the common implied type.
  PR 2 adds d5 as a test with a mutant witness (equality-only join), and g1
  with a mutant witness (binary fold instead of the n-ary join).

### 17. Not changed

- What narrows and what paths are stable (`SmartCastStability`): locals,
  parameters, implicit fields, stable member paths; e20's global behaviour.
- Member-bearing paths die on any call or member write (ADR-0069 #1180).
- Assignment narrowing proves non-nil, never the assigned class (#4989).
- The #2442 closure rule (e14 stays rejected).
- `!!` is a runtime check and does not narrow later reads (e11 stays
  rejected; open question 1).
- `catch` entry sees the try block's writes (e6 stays rejected); `finally`
  entry sees the writes of the try block and of every catch body and filter
  (c1 stays rejected); `finally` exit transfer (e19 stays accepted);
  `while x != nil` re-proves per iteration (e13); nullable reassignment in
  a loop kills (e4); shadowing in a loop (e16); aliased `out`/`ref` storage
  in a loop (the `out-alias` row stays rejected); a forward jump into a
  backward-jump region and a write that returns through another label (c3a,
  c3b stay rejected); a local callable shadowing a type name is a call (d2
  stays rejected); an outer non-null proof survives an inner strengthening
  branch (d5 stays accepted); dead code and jumps through a non-completing
  `finally` add no edges (d6 stays accepted and prints 4).
- `[MemberNotNull]`, `[NotNullWhen]`, `[MaybeNullWhen]`, `[MemberNotNullWhen]`
  rules; `if let`, `guard let`, `while let`, pattern-variable scoping
  (ADR-0166, ADR-0201); the `&&`/`||`/`??`/`?:` classification; `GS0536`
  rules including the ADR-0186 `T!` exemption; `GS0523` suppression on
  narrowed reads.
- Async and iterator bodies: narrowing is decided at bind time on the
  unlowered body. `await` and `yield` do not invalidate plain locals that
  no closure assigns and that are not in the alias class; what they do
  invalidate is row R13.
- Definite assignment (`DefiniteAssignmentAnalyzer`) and definite return are
  separate analyses on the lowered body and are untouched; #5142 may later
  share its CFG with the follow-up ADR's loop walker (section 10) without
  changing a result.
- Loop and backward-`goto` narrowing: the re-bind, the back-edge analysis,
  the deferred re-report and all their results (section 10), apart from the
  R11 and R12 transfers that now apply inside loops too.

### 18. Performance expectations

With the study's profile as the baseline (section 4.7) and #5152 landed:

- The per-statement bound walks disappear as a class: effects are composed
  once per node (`narrowing.effect-walks` equals the statement count,
  `narrowing.effect-reuses` is retired).
- The per-loop lowering, `ControlFlowGraph` and second bind stay (section
  10). A new counter, `narrowing.loop-rebinds`, is added in PR 1 to measure
  how many loop bodies the current design binds twice on Core, Core.Tests
  and Oahu; it is the follow-up ADR's first input.
- `ApplyIfJoinNarrowings` and `ClearAssignedRoots` disappear;
  `CaptureCallableState` copies disappear with the alias set folded into
  the state. The 21-entry loop snapshot and its `Clone()`s stay until the
  follow-up.
- Expected: the narrowing-attributable frames
  (`AssignedRootsCollector` 5.9%, `UpdateExternalCallableAliases` +
  `InvalidateNarrowingsForAssignedVariables` 6.6%, alias-set copies 1.1%)
  fall to under 4% of main-thread samples, the remainder being the loop
  collector, and the `bodies` phase drops by a further 4-8% after #5152's
  13%. These are estimates; the implementation
  PRs report the measured table from `build/compiler-bench.py` (#5163,
  merged; `docs/self-host-benchmark.md`), over the Core, LanguageServer
  and hello-world cells, with `GSHARP_MEASURE_PHASES` phases and counters.
- Measured by PR 1 (#5212, no semantic change, comparison mode off):
  implementation DLL, reference assembly, PDB, XML and diagnostics
  byte-identical on Core, Core.Tests, gsc and 12 Oahu projects; Core wall
  57.06 s to 56.16 s and `bodies` 44,485 ms to 43,861 ms (noise; the PR made
  no performance claim); `narrowing.loop-rebinds` Core 62, Core.Tests 0, gsc
  0, Oahu 7, which is the follow-up ADR's first measurement of how often
  today's second bind happens.

### 18a. Scope: the recorded decision

The maintainer accepted this ADR with the split scope (PR #5164,
2026-10-23). This ADR covers the join representation, the query, the
bottom-up effects, the expression-granular updates, and the handler and
`finally` entry rules (sections 6 to 9 and 11 to 14), implemented by PRs 1
and 2 of section 19 and cleaned up by PR 4. Loops and backward jumps keep
today's mechanism (section 10), and their redesign moves to a follow-up ADR
that starts from the measured spike described there. What follows from the
split:

- R-table: R1 to R6 and R9 to R14 (R14 added by amendment A2), including
  the accepted-program output change of R1 (b) and the overload rejection
  of R1 (c) (open question 3). R7 and R8 are deferred with section 10.
  Section 16 is the one list of rows; every other mention of "the rows"
  means that list.
- Plan: PRs 1, 2 and 4. The loop-related deletions (per-loop CFG,
  21-structure snapshot, diagnostics truncation, `GotoNarrowingSnapshot`,
  proof generations) are deferred with them.
- Acceptance: as section 19 states for PRs 1, 2 and 4. The `bodies` target
  of section 18 is the part the per-statement walks and the `if`-join
  interpreter cost (the `AssignedRootsCollector` and `Update*`/`Invalidate*`
  frames, about 12.5% of main-thread samples); the loop re-bind cost is
  measured by the counter, not removed.
- Bootstrap: two known restructurings in `src/Core`, both from R14
  (`ExpressionBinder.Access.MemberLookup.gs:3991`,
  `BaseCallForwarderRewriter.gs:490`; section 15 and 19a), done in the
  pin-move PR. The four functions that the draft's loop rule rejected were
  all loop cases and stay with the follow-up ADR.

Reasoning the maintainer accepted: four review rounds found defects only
in the entry-state rules for loops and backward jumps, none in the join
representation; three of the counterexamples were soundness holes in the
current compiler (#5168, #5170, #5171) that the invariant closes regardless
of how loops are handled; and the join representation is where the measured
cost and the simplification are. The alternative, one ADR that also carried
the conservative loop design, is recorded under Alternatives considered.

### 19. Implementation plan (#5130)

Each PR: narrowing conformance suite green except the rows it lands; every
new or changed behavioural test carries an ADR-0154 witness (red on the
pre-change compiler or under a mutant); byte-identical implementation,
reference, PDB and XML output and identical diagnostics on Core, Core.Tests
and the pinned Oahu inputs except where the PR's rows predict a change,
each predicted change listed in the PR body; the benchmark table of section
18; and a compile of Core, Core.Tests and gsc with the built compiler
(the References section) with zero diagnostics outside the landed rows.

1. **Representation (no semantics change; landed as #5212).**
   `NarrowingState`, `StatementEffects` composed bottom-up in a side table,
   `BinderContext.Narrowing`, and the query. The frame list stays the
   mechanism in this PR and `BinderContext.Narrowing` is its projection
   (the innermost frame wins); every existing pass keeps its rule. PR 2
   replaces the frames when it consumes the join, because two couplings
   make a literal replacement a behaviour change: a block pop drops the
   inner frame's facts while the lifts write into the enclosing frame (row
   R3 is this), and the retained backward-`goto` checker is keyed by frame
   identity (`NarrowingFrameIndices`, `GetNarrowingProofGeneration`,
   `BinderContext.gs:795-800`). Adds `narrowing.loop-rebinds`. Implements
   the section 9 join in shadow: computed from the branch exit states at
   the merge points it covers (`if` with `else if` chains and initializers,
   `switch` statements, bare blocks; `try`, labels, `goto` joins and
   expression-level merges are PR 2's) but not yet consumed; because the
   branches share the frame stack, the shadow restores a fact an earlier
   branch killed for the later branch and carries nested proofs in an
   overlay, an approximation of the exit states PR 2 computes exactly. Adds
   the **comparison
   mode** `GSHARP_NARROWING_COMPARE=<path>`: the binder compares the shadow
   join with what the old passes lifted and writes every disagreement as
   `file:line, path, old type, new type, row`, and separately every read
   whose member selection or emitted cast would change. Adds the
   **construct table** with its exhaustiveness test over every `BoundNode`
   subtype, and the **regression corpus**: one test per row of the section
   4 probe table (e1-e21, c1-cC, d1-d6, f1-f6 and any later row), with the
   row's expected result and an ADR-0154 witness (run-time failure on
   today's compiler for the soundness rows, a mutant for the others).
   Acceptance: byte-identical output; every disagreement on Core,
   Core.Tests and Oahu falls under a row of section 16 (the shadow join is
   the new rule, so R1 to R6 are expected to appear there), none outside
   the table; the member-selection and cast report for open question 3.
   Result
   (#5212): output identity met; the disagreement criterion not met, with
   four sites outside the table, resolved by amendments A1 and A2 of
   section 19a.
2. **Joins from exit states (every row of section 16 that is in scope: R1
   to R6 and R9 to R14).** `if`, `switch`, blocks, `try`, cleanup regions,
   forward `goto`, labels; the catch-clause entry rule (R10);
   expression-granular state updates (R9); the construct table's `call`
   effects for mutable globals, the alias class and suspension points (R11
   to R13) and for property reads with user code (R14, amendment A2); the
   join type rule as amended by A1 (`NarrowingState.JoinTypes`); the
   frame list replaced by the threaded state; delete `ApplyIfJoinNarrowings`,
   `ComputeIfJoinNonNull`, `ProcessBranchStatement`, `ClearAssignedRoots`,
   `RestoreEarlyExitLiftsWrittenOnlyByCondition`, `PendingEarlyExitFrames`,
   `PendingSwitchExitFrames`, the #4285/#4290 suppressions; the `try`
   handler and `finally` entry states of section 9. Acceptance: the
   comparison mode's disagreements on Core, Core.Tests and Oahu all fall
   under a row of section 16 that is in scope (R1 to R6, R9 to R14), none
   outside; the listed tests re-expected with witnesses; c1 and e6 added as
   tests (red under a mutant that builds the `finally` entry from normal
   exits), cA, d1, d3b, d4b, f2, f3, f5 and g2 (red on today's compiler by
   running the program), d5 and g1 (red under join mutants), the #5206 repro
   (red under the fallback as first written) and the two R14 shapes (red
   under a mutant that classes property reads `none`); the `GS0536` sites
   the new compiler reports in repository source and the two R14 sites
   (section 15) are listed in the PR body for the pin-move PR.
3. **Loops and backward jumps: deferred.** Under the recorded scope
   (section 18a) there is no PR 3 in this ADR. The loop and backward-jump
   collectors are touched only by PR 1 (they read the state value) and PR 2
   (they apply the construct table, so R11 and R12 hold inside loops). The
   follow-up ADR of section 10 owns the kill-set walker, the deletion of
   `BindLoopBody`'s snapshot and re-bind, `CollectLoopBackEdgeMutations`,
   the per-loop CFG, `BackwardGotoNarrowingStates`, the proof generations,
   `ReportUnsafeBackwardGotoNarrowings` and `GotoNarrowingSnapshot.gs`, and
   the re-expectation of `Issue2943` and `Issue4519`. Its inputs are the
   `narrowing.loop-rebinds` counter and the comparison-mode report from PR
   1.
4. **Cleanup.** Delete the single-entry effects cache and every use of
   `AssignedRootsCollector` outside the loop and backward-jump collectors
   (which keep it until the follow-up ADR), fold the alias set into the
   state, remove the comparison mode, update ADR-0069's superseded
   paragraphs with pointers to this ADR, update `website/docs/ref/spec.md`
   section "Smart casts" and `website/docs/tour/control-flow.md`, release
   notes under Unreleased. Acceptance: `StatementBinder.Narrowing.gs`
   reduced to the classifiers, the transfer functions and the loop
   collector; benchmark table; full suite green.

The pin-move PR after the release that carries PR 2 removes the `!!` that
`GS0536` newly reports (section 15).
Slice 2a rewrote the first two such sites with a local copy, so the pin-move PR no longer needs them: `DeclarationBinder.Functions.gs` (`typeArguments`) and `MethodBodyEmitter.MemberAccess.gs` (`TryLoadFromEnclosingClosure`).

### 19a. Findings of PR 1 and the amendments they led to

PR 1 (#5212) ran the comparison mode on Core, Core.Tests, gsc and the 12
pinned Oahu projects. Counts are first-divergence sites (a fact an earlier
merge point already proved is not counted again):

| Input | R1 | R2 | R3 | R4 | R5 | R6 | outside the table |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Core | 73 | 13 | 0 | 13 | 106 | 0 | 2 (#5215) |
| Core.Tests | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| gsc | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Oahu (12 projects) | 8 | 0 | 0 | 0 | 5 | 0 | 2 (#5206) |

Reads for decided question 3 (reported at the read): Core 362 reads would
narrow, 360 of them gain only a nil check (no cast, no member-selection
change) and 2 are type-test facts (`ConversionClassifier.gs:5095-5096`,
`inner` as `BoundLiteralExpression`, whose member `Type` both types have);
Core.Tests 10 and Oahu 7, all nil-check only; gsc 0. R3 and R6 have no site
because these inputs have no user `goto`. The four sites outside the table
were two defects of this document. The maintainer decided both amendments
on 2026-10-23 (PR #5226); for the implementation (#5130, PR 2) A1 is the
one function `NarrowingState.JoinTypes` and A2 is one predicate of the
construct table.

**A1 (#5206, P1, accepted 2026-10-23): the join keeps the declared non-null
type whenever every incoming state has a fact.** After `if settings is IInit
init { ... }` with `settings T?`, the then-state has `settings -> IInit` and
the else-state `settings -> T`; neither converts to the other, and `IInit`
does not convert to `T` with its representation preserved, so the fallback
as first written dropped the path and a later read saw `T?` (today's
compiler keeps `T`; `Oahu.Foundation/Auxiliary/SettingsManager.gs:51,
111`). Decision: drop the representation-preserving condition and extend
the fallback to stable member paths, as section 6 now states. The
maintainer's reason: do not break Oahu or other consumers. It is one rule
for all incoming facts, it matches section 15's statement that a
nullability fact emits no cast, and its only effect on today's results is
more permissive (the `goto` join's fallback widens to member paths and to
non-converting refinements). PR 2 adds the repro of #5206 as a corpus row
with a mutant witness (the fallback as first written) and re-runs the
`goto` join tests of `Issue4519` for the widened fallback. Rejected
alternatives: counting only type-test refinements as convertible (a shape
test); recording the drop as a less-permissive row (would reject the two
Oahu sites and any program that tests a nullable local against an interface
its type does not implement).

**A2 (#5215, P1, accepted 2026-10-23): a property read with user code is a
call, in a condition too, and row R14 records it.** Section 8 classes a
non-auto property read as `call`; section 9 applies a condition's effects
before its branches; together a condition that only reads such a property
kills every member-path fact. Today's straight-line kill follows the
statement's syntax (calls and member writes), so it keeps the fact; today's
loop collector and `finally` summaries already kill on the read
(`:1751-1753`). Decision: keep the kill, row R14 as written in section 16.
It is the conservative default of section 6 applied as stated (ADR-0069
#1180: an intervening call invalidates member paths), it removes the
inconsistency between today's straight-line and loop collectors, and it
costs two restructurings. The pin-move PR restructures these two sites of
`src/Core` by reading the property into a `let` before the guard, not with
`!!` (section 15): `src/Core/CodeAnalysis/Binding/ExpressionBinder.Access.
MemberLookup.gs:3991` (`if getResultCall.Receiver is not
BoundImportedInstanceCallExpression getAwaiterCall { return }`) and
`src/Core/CodeAnalysis/Lowering/BaseCallForwarderRewriter.gs:490` (`if
method.ReceiverType is not StructSymbol declaring { return }`). No site in
Core.Tests, gsc or the pinned Oahu inputs. Rejected alternatives:
exempting a read whose path is the fact's own subject (a shape test; the
getter can still mutate other reachable state); classing every property
read as `none` for member paths (today's straight-line rule, unsound in the
same way: a getter with user code can write the member a path names).

**Clarifications from #5207 (not design choices)** are folded into the text
of this revision: PR 1 keeps the frame list (section 19), `KillRoots` takes
`IReadOnlyCollection[VariableSymbol]` (section 7), the construct table
covers every concrete `BoundNode` type and gives one class per type with
binder-side refinement as a later table change (section 8), the effects
record holds raw sets with the alias-dependent answer derived at the use
site and statements with function literals walked (section 13), and the
shadow's coverage and approximation (section 19).

### 20. Risks

- **A rule the model cannot express without the interpreter.** Mitigation:
  PR 1's comparison mode runs both on Core, Core.Tests and Oahu before any
  rule changes; a disagreement there is a defect in the new model, not a
  row.
- **A rule that is not derived from the invariant.** Five review rounds on
  the drafts of this ADR found twenty: a finally entry built from normal
  exits, a catch entry that ignored earlier filters, a finally entry that
  ignored enclosing filters, a catch entry that ignored a replacement
  exception after an enclosing filter, a non-null proof without the
  exact-storage restriction, a construction proof that ignored call-binding
  precedence of a shadowing local, a construction proof that accepted a
  value type that boxes to nil, a backward-`goto` region that ignored other
  entries and dead or non-arriving jumps, an external-alias exemption that
  is not invariant over the loop, a callee classification that missed
  callable arguments and captured-writing local functions, a by-reference
  parameter that a callback writes without a `ref` at the call, mutable
  globals missing from the call kill set, calls introduced by lowering
  missing from a compound statement's effects, `ref`-local aliases missing
  from the alias class, element and member aliases missing from it, an
  equality-only join that lost a strengthened fact, a join without the
  declared-root fallback, an unrecorded output change at else-exit joins, a
  construction-syntax dependence in the non-null proof, and an inventory
  entry that misread a test. Thirteen of them accepted a program that
  dereferences nil; seven of those (cA, d1, d3, d4, f2, f3, f5) are
  accepted by 0.5.212 too and are filed as #5168, #5170 and #5171. The
  fifth round changed the method: section 6 now has the conservative
  default and section 8 the closed proof list and the construct table, so
  a further finding of this kind is a table entry or a corpus row. The
  earlier mitigation stands: section 6 states
  the invariant and the region lower bound with indirect writes named;
  every entry-state rule in sections 9 and 10 is an instance of the lower
  bound and, where a classification would need bound information before
  binding, the rule does not classify; PR 1 adds every counterexample of
  section 4 (c1, c3a, c3b, `out-alias`, c5, c6, c7, c8, c8b, cA, cB, cC, d1
  to d6, f1 to f6) to the regression corpus with witnesses, and a review
  that finds a rule not derivable from the invariant blocks the PR.
- **The filter-write scan misses a write form** (a new assignment syntax, a
  deconstruction, a compound operator). The failure direction is unsound
  (a fact survives a write). Mitigation: the scan treats every syntax kind
  it does not know as `call`, and a test enumerates the syntax kinds against
  the scan's list, so adding a kind without updating the scan fails. The
  same mitigation covers the follow-up ADR's loop walker.
- **IL churn from type-test facts at joins** (section 15). Mitigation: the
  comparison mode classifies every emitted-cast difference; if the churn on
  Oahu is large the maintainer can choose open question 3.
- **Bootstrap**: a less permissive row rejects repository source only at
  the pin move. Mitigation: the response-file compile in every
  implementation PR (the References section); the two known restructurings
  (R14, section 15) are listed for the pin-move PR, and no other is known
  under the recorded scope.
- **Performance regression from immutable states** in bodies with many
  facts. Mitigation: states are tiny arrays; the benchmark table gates each
  PR.

### 21. Decided questions

The maintainer accepted this ADR and its scope (section 18a) on 2026-10-23
and, on the same day, decided each question below as recommended. The
recommendations are therefore decisions; questions 4, 6 and 7 are deferred
to the loop and backward-`goto` ADR tracked in
[#5196](https://github.com/DavidObando/gsharp/issues/5196). The PR named
with each question is the one that first depends on it.

1. Should `x!!` narrow `x` for the rest of the flow region (e11)? It is a
   runtime check, so it is sound; CLAUDE.md discourages `!!` as a flow
   device. Decided: no. Depends on nothing in PRs 1 and 2; a yes would be a
   later, additive change.
2. Should a `var` local that no closure assigns keep its narrowing inside a
   closure body when no write to it follows the closure's creation point?
   The #2442 addendum declined path sensitivity. Decided: keep #2442
   unchanged (P8). PR 2.
3. Should type-test facts (`is`) survive joins (R1, R5) or only nullability
   facts? Uniform joins emit new `castclass` at join points and, where a
   member is hidden, select the narrowed type's member where today's read
   selected the declared type's (probe f6: `animal` today, `dog` after; R1
   (b)). This is an output change in accepted programs and it happens under
   the recorded scope. The alternative, lifting only nullability facts past
   a join while keeping today's then-exit lift of type-test facts, avoids
   the change at the price of one more rule. Decided: uniform joins, with
   PR 1's comparison mode reporting every member-selection, overload (R1
   (c)) and cast difference on Core, Core.Tests and Oahu before PR 2 lands,
   so the maintainer sees the numbers before the change ships. PR 2. The
   numbers from PR 1 are in section 19a: of 362 Core reads that would
   narrow, 2 are type-test facts and neither changes member selection;
   Core.Tests 10 and Oahu 7 are nil-check only.
4. Deferred with section 10 to the follow-up ADR (#5196): whether a call to
   a function whose declared return type is non-nullable counts as a
   non-null proof across a back edge (the draft dropped
   `FunctionReturnsDefinitelyNonNull`). No PR of this ADR depends on it.
5. Should the per-statement entry states be kept for `SemanticModel`
   (section 14) in PR 1, since they are free, or left out until a consumer
   exists? Decided: leave them out of PR 1 and add them behind the
   language-server consumer that needs them (ADR-0099 quick fixes are the
   likely first one). PR 1.
6. Deferred with section 10 to #5196: the hidden-member re-selection when a
   loop drops a type-test fact (the draft's R7 (d)). No PR of this ADR
   depends on it.
7. Deferred with section 10 to #5196: a syntactic exemption from the
   any-call kill for `static`/top-level callees without callable arguments
   (the draft's rule 4). No PR of this ADR depends on it.
8. Scope: decided. The maintainer chose the split scope recorded in section
   18a (2026-10-23): this ADR covers the join representation, query,
   effects and handler entry; the loop and backward-jump redesign is the
   follow-up ADR of #5196, after the measured spike of section 10.

## Consequences

Positive:

- One rule for every merge point and one rule for every handler entry. The
  irregularities of the stack design (a `goto` anywhere disables joins; a
  block pops its facts; an else-exit does not lift; switch arms do not
  join) go away as a class rather than shape by shape.
- The O(depth x size) walks and the `if`-join interpreter are removed
  structurally, with `StatementBinder.Narrowing.gs` reduced to classifiers,
  transfer functions, one state type and the loop collector. The per-loop
  CFG, the second bind of loop bodies, `GotoNarrowingSnapshot.gs` and the
  goto proof machinery in `BinderContext.gs` stay for the follow-up ADR
  (section 10), with a counter that measures what they cost.
- Four soundness holes close (R9, R10, R11, R12), three of them present in
  the current compiler (#5168, #5170, #5171); R13 and R14 close potential
  ones and remove an inconsistency between today's straight-line and loop
  collectors.
- The design has a conservative default and closed lists (sections 6 and
  8), so a later finding is a table entry or a corpus row.
- The state is a value, which makes per-position queries for tooling
  possible later at no cost to batch compilation.

Negative:

- Less permissive changes R9 to R12, all soundness fixes: a program that
  dereferences nil today gets a diagnostic. R13 and R14 are
  conservative-default rejections of programs that are correct today (a
  closure-assigned local read across a suspension point; a member-path
  fact read after a condition that calls a getter with user code), R14
  costing two restructurings in `src/Core` at the pin move; R1 (c) rejects
  an overload call that a newly surviving type-test fact makes ambiguous.
- One accepted-program output change, R1 (b): a hidden member read after a
  join selects the narrowed type's member (open question 3).
- IL can change at join points for type-test facts (section 15).
- A pin-move PR with `!!` removals.
- The filter-write scan is a second, syntactic notion of "writes" beside the
  bound effects; the enumeration test in section 20 keeps them aligned.
- The loop re-bind, the per-loop CFG and the goto proof machinery remain
  until the follow-up ADR; the study's full M1b target is not reached by
  this ADR alone.

Neutral:

- ADR-0069 remains the semantics reference for what narrows; this ADR
  supersedes its implementation notes and the three #2943 and #4216
  paragraphs named in section 16. ADR-0183's window-widening decision is
  compatible with this model (a lifted member-path fact is just a fact in
  the state) and is not changed in status by this ADR.
- #5142's shared CFG is not a prerequisite. If it lands before the
  follow-up ADR, that ADR's loop walker can read the loop's assigned roots
  from the CFG instead of the syntax.

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
- **One ADR carrying the conservative loop design as well** (the draft's
  section 10 as a decision, with rows R7 and R8, four restructurings in
  `src/Core`, and the full deletion list and performance target). Set
  aside by the maintainer in favour of the split scope of section 18a: four
  review rounds found defects only in the loop and backward-jump entry
  rules, and each fix cost precision, so that part gets a measured spike
  and its own ADR before it is decided. The draft stays in the history of PR
  #5164 (commit 001ee4ff5) as the follow-up's starting point.
- **Keep the loop fixpoint with re-bind for good** (never redesign loops).
  Not chosen either: #5130's acceptance asks for no second bind of loop
  bodies, and the re-bind keeps the snapshot and truncation machinery that
  review showed to be the hardest part of this area to reason about. The
  recorded scope keeps it for now and measures it (`narrowing.loop-rebinds`)
  so the follow-up decides on numbers.
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
- **Name-based kill set without scoping** (for the follow-up: the draft's
  rule 1 without the declaration stack). Simpler, but rejects e16, which
  compiles today and which the symbol-identity rule of #2943 was added for.

## References and reproducibility

- Probes: `~/.cache/narrowing-adr/exp/e*.gs`, run with
  `bash ~/.cache/narrowing-adr/exp/run.sh [gsc.dll]`; the default compiler
  is the pinned 0.5.212 SDK's `tools/compiler/gsc.dll`. Each probe file is
  named after its row in the section 4 table and holds the shape the row
  quotes; PR 1 commits them as the regression corpus.

- Repository compile with a built compiler (used for the two loop-rule
  experiments and required by section 19): build
  `src/Compiler/Compiler.gsproj` and `test/Core.Tests/Core.Tests.gsproj`
  with the pinned SDK; take `out/obj/{Core,Core.Tests,Compiler}/Release/
  {GSharp.Core,GSharp.Core.Tests,gsc}.rsp`; strip the BOM and redirect
  `/out:`, `/refout:`, `/pdb:` and `/doc:` into a work directory under
  `~/.cache/`; run `dotnet <built>/gsc.dll @<rsp>` from the project
  directory. `build/compiler-bench.py` (#5163, merged) automates the same
  with output parity; its work root defaults to `~/.cache/q9-bench/` and it
  refuses `/tmp` without `--allow-tmp`.
- Code references in this document are to `main` at `51fcab9c9` (#5159);
  the cited files under `src/Core/CodeAnalysis/Binding/` are unchanged at
  `081a72bd4` (#5178), so the line numbers still hold.
- Kotlin K2 precedent: the compiler's local-variable assignment analysis
  pre-pass collects, per loop and lambda, the local variables assigned
  inside it; the data-flow analysis then treats those variables as unstable
  at the loop entry, so smart casts on them are dropped there.
