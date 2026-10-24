# ADR-0208 probe corpus

Companion to [ADR-0208](0208-narrowing-as-flow-state-with-a-query.md),
section 4. This file holds the probe table that the ADR's rules are checked
against and that PR 1 of #5130 (PR #5212) turned into the regression corpus
`Adr0208NarrowingCorpusTests` (one test per row, exact diagnostics, ILVerify
and run output). A row's "0.5.212" column is today's result on the pinned
compiler; the ADR's section 16 says which rows change and how. Later review
rounds add rows here, not rules to the ADR.

Sources: `~/.cache/narrowing-adr/exp/<row>.gs` during the ADR's review, now
the corpus tests. Compile one with the pinned compiler:
`dotnet ~/.nuget/packages/gsharp.net.sdk/0.5.212/tools/compiler/gsc.dll <file> /out:<dll> /target:exe`.

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

## PR 2, slice 2a: rows that changed and rows that were added

Slice 2a (amendment A1 in `NarrowingState.JoinTypes`, and the lift of the join of `if` and bare-block exit
states) flipped these rows. The corpus test records the new result, and the "0.5.212" column above is still
the pinned compiler's result.

| Probe | After slice 2a | Row |
| --- | --- | --- |
| e7 (Run2) | accepted, `b.Pet.Bark()` | R1 (a), member path |
| e8 | accepted | R1 (a) |
| e10 | accepted | R3 |
| e21 | accepted | R5 |
| f1 | accepted | R1 (a) |
| f6 | prints `dog` | R1 (b) |
| g4 | `GS0266` at the call | R1 (c) |

The rows e9 (R4), e17 (R2), g1 and the `goto` rows (R6) did not change. New rows:

| Probe | Shape | Result |
| --- | --- | --- |
| h1 | `var t = Get(); if t == nil { t = "x"; return 1 }` then `t.Length` | rejected until slice 2b (R2): a write in the statement stays a legacy kill |
| h2 | `if b.Pet is Dog { } else { Log(); return "" }` then `b.Pet.Bark()` | rejected until slice 2b (R2): a call in a branch stays a legacy kill |
| h3 | `if Ready() && b.Pet is Dog { } else { return "" }` then `b.Pet.Bark()` | accepted (R5): a call in the condition runs before the fact holds |
| h4 | the same with `Log()` in the then-branch | rejected: the call runs after the fact and kills the member path |
| h5 | `if x == nil { return }`, `if x is Dog { } else { return }`, then `x.Bark()` | accepted: the join strengthens the fact of the guard |
| h6 | `if b.Pet == nil { return }`, `if Ready() { } else { return }`, then `b.Pet.Name` | rejected: the call in the condition kills the entry fact, and a join never puts an entry fact back (row R14 keeps it rejected) |
| k1 | `var x Animal? = a`; both branches of `if c` hold `if x !is Dog { return }`; then `x.Bark()` | accepted: the legacy `if` join lifts `Animal` first and the join then strengthens it to `Dog` |
| k2 | `if s == nil { return 0 }`, `if Clear(ref s) { return s.Length }` where `Clear` stores nil | accepted with GS0612, throws `NullReferenceException` in 0.5.212 and now: a condition's write is not applied before its branches ([#5249](https://github.com/DavidObando/gsharp/issues/5249), slice 4) |
| h7 | the same as h2 with a read of a property getter with user code in the exiting branch | rejected until slice 2b (R2): the getter is a call for member paths (#5214) |
| i1 | `Make[T class init()]`: `if settings is IInit init { }` then `return settings` (#5206) | accepted before and after; the shadow report names a dropped fact if A1 is reverted |
| i2 | the same with a forward `goto Done` out of the type test | rejected by 0.5.212 with GS0155, accepted after: the `goto` join takes the declared type (A1) |
| j1 | `x object?`; `if k == 0 { x !is Animal ... } else if k == 1 { x !is Dog ... } else { x !is Cat ... }` | accepted: the `else if` chain joins three states at once |

## Experiments on the deferred loop rule

These measured the loop kill set that ADR-0208 section 10 defers to the
follow-up ADR (#5196). Each built the compiler from the ADR branch with a
local, uncommitted edit and compiled the `GSharp.Core`, `GSharp.Core.Tests`
and `gsc` response files with it; the unmodified build gave 0 errors as the
control.

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
