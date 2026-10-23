# ADR-0208: Narrowing as a flow-state computation consumed through a query

- **Status**: Accepted (maintainer decision on PR
  [#5164](https://github.com/DavidObando/gsharp/pull/5164), 2026-10-23, with
  the split scope of section 18a; the eight questions of section 21 were
  decided as recommended on the same day, three of them deferred to
  [#5196](https://github.com/DavidObando/gsharp/issues/5196))
- **Date**: 2026-10-22 (accepted 2026-10-23)
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
| c1 | guard; `try { throw } catch { s = nil; return 0 } finally { Consume(s.Length) }` | rejected |
| c3a | `if skip { goto Inside }; if s == nil { return }; Again: Consume(s.Length); Inside: goto Again` | rejected |
| c3b | guard; `A: Consume(s.Length); if flag { goto C }; B: goto A; C: s = nil; goto B` | rejected |
| out-alias | `func Run(out c C?, ref alias C?)`: guard on `c`; loop `c.M(); c = C(); alias = nil` (`Issue2943LoopBackEdgeNarrowingTests.gs:326-338`) | rejected |
| c5 | guard; `var action = External; let clear = func() { s = nil }`; loop `s.Length; action(); action = clear` | rejected |
| c6 | guard; `let clear = func() { s = nil }`; loop `s.Length; Invoke(clear)` where `func Invoke(f () -> void) { f() }` | rejected |
| c7 | `func Run(ref text string?, callback () -> void)`: guard; loop `text.Length; callback()`; caller passes `ref t` and a callback that sets `t = nil` | rejected |
| c8 | `Animal.Name -> "animal"`, `Dog.Name -> "dog"` (hiding); `if x is Dog { loop { last = x.Name; x = Dog{} } }` | accepted, prints `animal` |
| c8b | same with `x = Dog()` | accepted, prints `dog` |
| cA | guard; `try { throw } catch when Clear(ref s) { return 1 } catch { return s.Length }` where `Clear` stores nil and returns false | accepted (warning GS0612 only); throws `NullReferenceException` at run time |
| cB | guard; `let clear = func() { s = nil }`, `let twice = func() { clear(); clear() }` (a direct-call local function group); loop `s.Length; twice()` | rejected |
| cC | `Again: let length = x.Length; if count == 0 { count++; try { x = nil; goto Again } finally { x = "safe" } }` (`Issue4519:3609-3631`) | accepted, prints `4` |
| d1 | guard; `try { try { throw } finally { Consume(s.Length) } } catch when Clear(ref s) { return 1 }` where the filter stores nil and returns true | accepted (GS0612 only); the finally dereferences nil, the resulting `NullReferenceException` is caught by the same handler, prints `1` (instrumented variant d1b shows the order `filter`, `finally: nil`, `filter`) |
| d2 | guard on `s StringBuilder?`; `let StringBuilder = func() StringBuilder? { return nil }`; loop `s.Length; s = StringBuilder()` | rejected |
| d3 / d3b | top-level `var text string?`; `func Clear() { text = nil }`; `text = "safe"` then `Clear()` then `text.Length` (d3 inside a loop, d3b straight-line) | accepted; both throw `NullReferenceException` |
| d4 / d4b | `var x C? = C{}; let ref a C? = x; if a == nil { return }` then `x = nil` then `a.Value` (d4 inside a loop, d4b straight-line) | accepted; both throw `NullReferenceException` |
| d5 | `x Animal?`; `if x != nil { if x is Dog { } return x.Name }` | accepted |
| d6 | `BackwardGoto_ThroughNonCompletingFinally_DoesNotActivateTargetEdges` (`Issue4519:6195-6215`): `goto After; Enter: x = nil; goto Use; After: try { goto Enter } finally { return 4 }; Use: return x.Length` | accepted, prints `4` |
| f1 | `x Animal?`; `if c { if x !is Dog { return } } else { if x !is Cat { return } }` then `x.Name` | rejected (branch joins never lift a parameter; the `goto` join would keep `Animal`) |
| f2 | `let ref a C? = xs[0]; if a == nil { return }; xs[0] = nil; a.Value` | accepted; throws `NullReferenceException` |
| f3 | guard; `try { try { try { throw f } finally { throw g } } catch (InvalidOperationException) { return s.Length } } catch (FormatException) when Clear(ref s) { return 0 }` | accepted (GS0612 only); throws `NullReferenceException` |
| f4 | guard on `x object?`; loop `x.ToString(); x = System.Nullable[int32]()` | rejected |
| f5 | top-level `var text`; iterator `Items()` assigns `text = nil` in its body; `text = "safe"; for item in items { }; text.Length` | accepted; throws `NullReferenceException` |
| f6 | hiding `Animal.Name`/`Dog.Name`; `x Animal`; `if x is Dog { } else { return "" }; return x.Name` | accepted, prints `animal` |
| g1 | `x object?`; three paths to `Done:` proving `Dog`, `Cat` and `Animal` through `!is` guards and `goto`; `x.Name` | rejected (the guard lifts are off in a function with `goto`, #4285) |
| g2 | `Run(ref a C?, xs []C?)`: `if a == nil { return }; xs[0] = nil; a.Value`, called as `Run(ref xs[0], xs)` | accepted; throws `NullReferenceException` |
| g3 | guard; `switch 1 { case 1 when Clear(ref s) { return 0 } }; s.Length` with `Clear` storing nil and returning false | rejected |
| g4 | `x IA`; `class Both : IA, IB`; `Take(IA)`/`Take(IB)`; `if x is Both { } else { return "" }; Take(x)` | accepted, prints `IA` |
| g5 | iterator: `let clear = func() { s = nil }`; `if s != nil { yield 0; yield s.Length }` | accepted, prints `0` and `1` |

c1, c3a, c3b, `out-alias`, c5, c6, c7, c8, cA, cB and cC are review
counterexamples against drafts of this ADR (PR #5164 threads on sections 9,
10 and 16). c1, c3a, c3b, `out-alias`, c5, c6, c7 and cB are rejected
today and the rules in sections 6, 9 and 10 keep them rejected. cA is a
soundness hole in 0.5.212 that the rules close (row R10; filed as bug
[#5168](https://github.com/DavidObando/gsharp/issues/5168), P1). c8 and
c8b show that today's back-edge proof depends on the construction syntax
(filed as [#5169](https://github.com/DavidObando/gsharp/issues/5169), P2);
the draft's loop rule (deferred, section 10) made the two forms uniform. cC
is accepted today and stays accepted under the recorded scope; the draft's
loop rule rejected it, which is a design change, not a defect, for the
follow-up ADR to weigh. The fourth review round added d1 to d6: d1 is a second shape
of #5168 (an enclosing filter runs before an inner finally); d3/d3b and
d4/d4b are two more soundness holes in 0.5.212, in straight-line code as
well as in loops, filed as
[#5170](https://github.com/DavidObando/gsharp/issues/5170) and
[#5171](https://github.com/DavidObando/gsharp/issues/5171) (both P1) and
closed by rows R11 and R12; d2 is rejected today and stays rejected; d5 and
d6 are accepted today and stay accepted under the join and reachability
rules of section 6. The fifth round added f1 to f6: f2, f3 and f5 are three
more shapes of #5171, #5168 and #5170 (comments on the issues), all
dereferencing nil today; f1 becomes accepted (row R1); f4 stays rejected;
f6 is an accepted program whose output changes (row R1 (b)).

The sixth round added g1 to g5: g2 is a fourth shape of #5171 (a `ref`
parameter aliasing an element; comment on the issue) and R12 covers it; g1
and g3 are rejected today and stay rejected (n-ary join; dispatch state
threading); g4 is an accepted program that R1 (c) rejects with GS0266; g5
is an accepted, correct program that R13 rejects under the conservative
default.

Every probe in this table is acceptance material: PR 1 of section 19 turns
the table into a regression corpus (one test per row, expected result per
row, ADR-0154 witness per row), and later rounds of this review add rows to
the corpus, not rules to the design.

A third experiment measured the draft's loop rule 4 (deferred with section
10): whole-loop kill, today's
bound non-null proof kept, and every call (direct, indirect, constructor)
marking the loop as able to write closure-assigned and by-reference roots
(`MayMutateAnyRoot` and `MayMutateWritableReferenceRoots` set on any call
in the loop collector). Result: 22 errors in three functions of
`src/Core` (`Binding/BinderContext.gs:906-923`, an `out` parameter read in
a loop that calls `TryGetValue`; `Binding/MemberLookup.gs:1108-1120` and
`:3100-3172`, locals that a closure elsewhere in the same function assigns,
read in loops that call), of which 5 are `GS0532` cascades; 0 errors in
Core.Tests and gsc. This is the whole measured cost of the conservative
call rule on the compiler's own source.

e20 contradicts ADR-0069's #712 addendum and `website/docs/ref/spec.md`,
which say a read-only top-level `let` narrows; the test
`Issue700SmartCastBinderTests.If_IsTest_OnGlobalVariable_DoesNotNarrow`
pins the rejection. This ADR does not change it; the documentation gap is
filed separately.

Two experiments measured the cost of the draft's loop rule (deferred to the
follow-up ADR, section 10) on the compiler's own source; they are the
spike's first data points. Both built the compiler from this worktree with a
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
non-null proof is load-bearing once. Both experiments used the bound
collector: roots by symbol identity (not the draft's scope-aware name
resolution) and today's call rule (not the draft's syntactic callee test).
They measure the draft's rules 2 and 3; its rules 1 and 4 are unmeasured
here, and the follow-up ADR's response-file compile is their measurement.

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
index or indirect write, and every call, kills every fact on the whole
alias class, parameters included (probe f2: `xs[0] = nil; a.Value` through
a `ref` local, and probe g2: the same through a `ref` parameter, both
compile and throw today; bug #5171, second and fourth shapes). The rule
does not try to tell which members of the class the write can reach.

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
`JoinJumps` hands the join every recorded state of a label at once. For a
path present in every incoming state, with incoming types `T1 ... Tn`, the
join keeps the one `Ti` to which every other `Tj` converts by identity or an
implicit reference conversion (`Dog` and `Animal` join to `Animal`; `T` and
`T?` do not join, because `T?` is not a fact). When no such `Ti` exists and
the path is a plain root whose every incoming type converts, with its
representation preserved, to the root's declared type with one nullable
layer removed, the join keeps that declared non-null type (`Dog` and `Cat`
on `x Animal?` join to `Animal`); otherwise it drops the path. A binary fold
would lose this: for `x object?` with incoming `Dog`, `Cat` and `Animal`,
`Join(Dog, Cat)` is `object` and `Join(object, Animal)` is `object`, while
the n-ary join keeps `Animal` (probe g1). This is exactly the rule the
`goto` join already uses (ADR-0069 #4989 addendum,
`FindCommonImplicitSupertype`, `StatementBinder.Narrowing.gs:3860-3885`,
over all incoming snapshots, including its declared-root fallback), applied
to every merge; it never computes a least common supertype of unrelated
types. It keeps an outer
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
    func KillRoots(roots LoopKillSet) NarrowingState

    /// Merge (section 6): a path survives with the incoming type the other
    /// converts to, or is dropped; aliases intersect. Unreachable is the
    /// identity.
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
- **P5 Join.** As defined in section 6: the incoming type the others
  convert to, the declared non-null type for a plain root whose incoming
  types all preserve representation into it, else drop.
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
classes, with representative kinds (93 kinds today: 18 statements, 59
expressions, 16 patterns, arms, clauses and attributes):

| Effect class | Kinds (representative) | Effect on the state |
| --- | --- | --- |
| `none` | `BoundVariableExpression`, `BoundLiteralExpression`, `BoundDefaultExpression`, `BoundTypeOfExpression`, `BoundSizeOfExpression`, `BoundLenExpression`, `BoundTupleElementAccessExpression`, `BoundIsExpression`/`BoundAsExpression` without user code, `BoundTypePattern`, `BoundDiscardPattern`, `BoundLabelStatement`, `BoundAwaitSequencePoint`, `BoundLocalFunctionDeclaration`, `BoundErrorExpression` | children only |
| `root-write` | `BoundAssignmentExpression`, `BoundVariableDeclaration` with an initializer, deconstruction targets, `out`/`ref` arguments, `++`/`--` on a name | removes every path on the root; if the root is in the alias class, every fact on the class; applies P2 afterwards |
| `member-write` | `BoundFieldAssignmentExpression`, `BoundPropertyAssignmentExpression`, `BoundIndexAssignmentExpression`, `BoundClrIndexAssignmentExpression`, `BoundClrPropertyAssignmentExpression`, `BoundIndirectAssignmentExpression` through an address-of operand | removes every member-bearing path and every fact on the alias class (a `ref` local or a by-reference parameter may alias the written element or member: probes f2, g2); a property setter with user code is also `call` |
| `pointer-write` | `BoundIndirectAssignmentExpression` through anything else, `BoundDereferenceExpression` as a target | removes every mutable root (`MayMutateAnyRootViaPointer`) |
| `alias` | `BoundAddressOfExpression`, `BoundConditionalAddressExpression`, `BoundManagedReferenceExpression`, `BoundFixedStatement`, `BoundStackAllocExpression`, a `ref` local declaration | puts the operand's root in the alias class; the write rules above then apply to the class |
| `call` | `BoundCallOperationExpression`, `BoundIndirectCallExpression`, `BoundFunctionPointerInvocationExpression`, `BoundConstructorCallExpression`, `BoundClrConstructorCallExpression`, `BoundTypeParameterConstructionExpression`, `BoundStructLiteralExpression` (field initializers), `BoundBaseClassCallExpression`, `BoundConstructorChainingExpression`, `BoundClrConversionCallExpression`, `BoundConversionExpression` with a user-defined conversion, `BoundBinaryOperationExpression`/`BoundUnaryExpression`/`BoundClrUnaryOperatorExpression` on user-defined operators, `BoundEventSubscriptionExpression`, `BoundClrEventSubscriptionExpression`, `BoundInterpolatedStringExpression` (`ToString`), `BoundAwaitExpression` (awaiter calls), `BoundForRangeStatement`/`BoundAwaitForRangeStatement` (`GetEnumerator`, `MoveNext`, `Current`, disposal; probe f5), `using`/`await using`/`lock`/`defer` cleanup regions (disposal, `Monitor`), `BoundGoStatement`, `BoundYieldStatement` (the consumer runs arbitrary code before resumption), property reads and `BoundPropertyPattern`/`BoundListPattern`/`BoundSlicePattern`/`BoundConstantPattern`/`BoundRelationalPattern` that invoke user code, `BoundMethodReferenceOperationExpression`/`BoundPropertyReferenceOperationExpression` when invoked, **and every kind not in the table** | removes every member-bearing path and every fact on the indirect-write class (mutable globals, closure-assigned locals, the alias class); in straight-line code with a bound callee, today's finer classification may keep closure-assigned locals when the callee has no captures, is not indirect through an unknown target and receives no unknown callable argument (`AnalyzeCallableArguments`, `:1930-1949`), and may keep mutable globals only when the callee is a declared function proven not to assign them, which this ADR does not define, so globals are always removed |
| `jump` | `BoundReturnStatement`, `BoundThrowStatement`, `BoundRethrowStatement`, `BoundThrowExpression`, `BoundGotoStatement`, `BoundConditionalGotoStatement`, `break`/`continue` | records the state on the target (through pending cleanup) and yields `Unreachable` |
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
- A jump (`break`, `continue`, `return`, `throw`, `goto`) records its state
  on the target and yields `Unreachable`. A jump that leaves cleanup regions
  is recorded with the regions still to run; when a region's cleanup has
  been bound (under the lower bound above, which is at most the state of any
  such jump), its exit transfer is applied to each pending state before the
  target joins it. This keeps the `GotoLeavingTry_*` and `*Finally*` results
  of `Issue4519GotoAssignmentNarrowingTests`.
- A user label is a join of the fall-through state and every recorded
  forward jump. Forward `goto` keeps its join rule, including the
  one-incoming-type-converts-to-the-others rule of the #4989 addendum
  (`FindCommonImplicitSupertype`); the predecessor list is in source order.

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
enclosing block. This is where #5152's single-entry cache
(`effectsNode`/`effects`, `:29-31`) becomes a table and the counter
`narrowing.effect-walks` becomes equal to the statement count.

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
     Under the recorded scope the less permissive rows are R9 to R12, and
     `src/Core` has no `when` filter that writes a narrowed root, no
     top-level `var` and no `ref` local, so no restructuring is known. The
     measurements in section 4 found four functions that the draft's loop
     rule (deferred) would reject: `ExpressionBinder.Assignments.gs:
     5435-5494` (reassignment from a pattern variable),
     `BinderContext.gs:906-923` (an `out` parameter read in a loop with a
     call) and `MemberLookup.gs:1108-1120`, `:3100-3172` (locals a closure
     in the same function assigns, read in loops with calls); they are the
     follow-up ADR's concern. If a restructuring is ever needed it must be
     a restructuring, not `!!`: under the pin, the pinned compiler proves
     the value non-null there and reports `GS0536`, and warnings are errors,
     so `!!` cannot bridge the two compilers. The implementation PRs compile
     Core, Core.Tests and gsc with the built compiler (the response-file
     procedure in section 24) to confirm.
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
| R12 | A write to any member of an alias class kills the facts on the whole class, and so does any member, index or indirect write, because a `ref` local or a by-reference parameter may alias the written element or member: `let ref a C? = x; ...; x = nil; a.Value` (probes d4, d4b); `let ref a C? = xs[0]; ...; xs[0] = nil; a.Value` (probe f2); `Run(ref xs[0], xs)` with `Run(ref a C?, xs []C?)` doing `xs[0] = nil; a.Value` (probe g2) (bug [#5171](https://github.com/DavidObando/gsharp/issues/5171)) | accepted, throws `NullReferenceException` at run time | GS0158 | less permissive (soundness) |
| R13 | A suspension point (`await`, `yield`) kills facts on mutable globals and on closure-assigned locals, because the code that runs while the function is suspended may invoke a closure that escaped: iterator with `let clear = func() { s = nil }`, `if s != nil { yield 0; yield s.Length }` (probe g5) | accepted, prints `0` and `1` | GS0158 | less permissive (conservative default; the program is correct) |

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

### 18a. Scope: the recorded decision

The maintainer accepted this ADR with the split scope (PR #5164,
2026-10-23). This ADR covers the join representation, the query, the
bottom-up effects, the expression-granular updates, and the handler and
`finally` entry rules (sections 6 to 9 and 11 to 14), implemented by PRs 1
and 2 of section 19 and cleaned up by PR 4. Loops and backward jumps keep
today's mechanism (section 10), and their redesign moves to a follow-up ADR
that starts from the measured spike described there. What follows from the
split:

- R-table: R1 to R6 and R9 to R13, including the accepted-program output
  change of R1 (b) and the overload rejection of R1 (c) (open question 3).
  R7 and R8 are deferred with section 10.
- Plan: PRs 1, 2 and 4. The loop-related deletions (per-loop CFG,
  21-structure snapshot, diagnostics truncation, `GotoNarrowingSnapshot`,
  proof generations) are deferred with them.
- Acceptance: as section 19 states for PRs 1, 2 and 4. The `bodies` target
  of section 18 is the part the per-statement walks and the `if`-join
  interpreter cost (the `AssignedRootsCollector` and `Update*`/`Invalidate*`
  frames, about 12.5% of main-thread samples); the loop re-bind cost is
  measured by the counter, not removed.
- Bootstrap: no known restructuring in `src/Core`. The four functions that
  the draft's loop rule rejected (section 15) were all loop cases.

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
(section 24) with zero diagnostics outside the landed rows.

1. **Representation (no semantics change).** `NarrowingState`,
   `StatementEffects` composed bottom-up in a side table, `BinderContext.
   Narrowing`, and the query. The frame list becomes save/restore of a state
   value; every existing pass keeps its rule. Adds `narrowing.loop-rebinds`.
   Implements the section 9 join in shadow: computed from the branch exit
   states at every merge point but not yet consumed. Adds the **comparison
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
   the new rule, so R1-R6 are expected to appear there), none outside the
   table; the member-selection and cast report for open question 3.
2. **Joins from exit states (R1-R6, R9).** `if`, `switch`, blocks, `try`,
   cleanup regions, forward `goto`, labels; the catch-clause entry rule
   (R10); expression-granular state updates; delete `ApplyIfJoinNarrowings`,
   `ComputeIfJoinNonNull`,
   `ProcessBranchStatement`, `ClearAssignedRoots`,
   `RestoreEarlyExitLiftsWrittenOnlyByCondition`, `PendingEarlyExitFrames`,
   `PendingSwitchExitFrames`, the #4285/#4290 suppressions; the `try`
   handler and `finally` entry states of section 9. Acceptance: the
   comparison mode's disagreements on Core, Core.Tests and Oahu all fall
   under R1-R6 or R9-R12; the listed tests re-expected with witnesses; c1
   and e6 added as tests (red under a mutant that builds the `finally`
   entry from normal exits), cA, d1, d3b and d4b (red on today's compiler
   by running the program) and d5 (red under an equality-only join mutant);
   the section 8 transfer for mutable globals and the alias class; the
   `GS0536` sites the new compiler reports in
   repository source are listed in the PR body for the pin-move PR.
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
  implementation PR (section 24); no restructuring is known under the
  recorded scope (section 15).
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
   so the maintainer sees the numbers before the change ships. PR 2.
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
  the current compiler (#5168, #5170, #5171); R13 closes a potential one.
- The design has a conservative default and closed lists (sections 6 and
  8), so a later finding is a table entry or a corpus row.
- The state is a value, which makes per-position queries for tooling
  possible later at no cost to batch compilation.

Negative:

- Less permissive changes R9 to R12, all soundness fixes: a program that
  dereferences nil today gets a diagnostic. R13 is a conservative-default
  rejection of correct programs that read a closure-assigned local across a
  suspension point; R1 (c) rejects an overload call that a newly surviving
  type-test fact makes ambiguous.
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
