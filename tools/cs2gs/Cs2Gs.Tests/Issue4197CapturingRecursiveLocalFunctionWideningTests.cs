// <copyright file="Issue4197CapturingRecursiveLocalFunctionWideningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4197 (follow-up to #3399/#3501 Track A2): <c>RegisterCapturingRecursiveLocalFunctions</c>
/// used to claim a mutual-recursion SCC only when at least one member
/// captured outer state, so a genuinely non-capturing mutual pair fell
/// through to <c>RegisterRecursiveLocalFunctionLifts</c> and was lifted to a
/// synthetic <c>__local_{Owner}_{Name}</c> helper purely for lack of a
/// capture — even though nothing about the nullable function-local scheme
/// actually requires one. Separately, that lift pass's reachability BFS
/// pulled in every non-recursive callee reachable from an already-claimed
/// SCC and lifted THEM too, rather than folding them into the same
/// forward-declared group under their real name.
///
/// This file adds the two positive regression cases described in the issue
/// (a non-capturing mutual pair now uses the nullable scheme; a capturing
/// cycle's non-recursive dependency folds into the same group) plus the two
/// carve-out guards (a generic or ref-returning member of a cycle must still
/// avoid the nullable scheme — see #4198 for the follow-up on actually
/// making those categories lift cleanly end to end).
/// </summary>
public class Issue4197CapturingRecursiveLocalFunctionWideningTests
{
    [Fact]
    public void NonCapturingMutualRecursion_UsesNullableScheme_NotLifted()
    {
        // Real corpus shape (src/Core/CodeAnalysis/Binding/MemberLookup.cs):
        // two `static` local functions, zero outer captures, mutually
        // recursive through each other. Before #4197 this lifted to
        // `__local_Run_FunctionShapesExactlyMatch` / `..._FunctionComponentExactlyMatches`
        // purely because the capturing gate excluded it; now it lowers to the
        // #3399 nullable-function-local scheme with its real names, exactly
        // like a capturing pair does.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Matcher
    {
        public bool Run(int a, int b)
        {
            return FunctionShapesExactlyMatch(a, b);

            static bool FunctionShapesExactlyMatch(int x, int y)
            {
                if (x == 0)
                {
                    return true;
                }

                return FunctionComponentExactlyMatches(x - 1, y);
            }

            static bool FunctionComponentExactlyMatches(int x, int y)
            {
                if (y == 0)
                {
                    return false;
                }

                return FunctionShapesExactlyMatch(x, y - 1);
            }
        }
    }
}");

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let FunctionShapesExactlyMatch", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let FunctionComponentExactlyMatches", printed, StringComparison.Ordinal);
        Assert.Contains("var FunctionShapesExactlyMatch", printed, StringComparison.Ordinal);
        Assert.Contains("var FunctionComponentExactlyMatches", printed, StringComparison.Ordinal);
        Assert.Contains("FunctionShapesExactlyMatch!!(", printed, StringComparison.Ordinal);
        Assert.Contains("FunctionComponentExactlyMatches!!(", printed, StringComparison.Ordinal);

        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Matcher().Run(4, 3)");
    }

    [Fact]
    public void CapturingCycleNonRecursiveDependency_FoldsIntoSameGroup_NotLifted()
    {
        // Real corpus shape (src/Core/CodeAnalysis/ControlFlowGraph.cs's
        // ProjectRegionsForDefiniteReturn): the capturing cycle `Add`/
        // `AddPatternSwitch` retires correctly via the nullable scheme, but
        // `CollectLabel` — a non-recursive helper called ONLY from inside
        // that cycle — used to be swept up by the lift pass's reachability
        // BFS and lifted to `__local_Project_CollectLabel` purely because it
        // was reachable. #4197 folds it into the SAME forward-declared group
        // instead, with its real name.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int total = 0;

            void Add(int depth)
            {
                total += CollectLabel(depth);
                if (depth > 0)
                {
                    AddPatternSwitch(depth - 1);
                }
            }

            void AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    Add(depth - 1);
                }
            }

            int CollectLabel(int depth)
            {
                return depth * 2;
            }

            Add(seed);
            System.Console.WriteLine(total);
            return total;
        }
    }
}");

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("var Add", printed, StringComparison.Ordinal);
        Assert.Contains("var AddPatternSwitch", printed, StringComparison.Ordinal);
        Assert.Contains("var CollectLabel", printed, StringComparison.Ordinal);
        Assert.Contains("Add!!(", printed, StringComparison.Ordinal);
        Assert.Contains("AddPatternSwitch!!(", printed, StringComparison.Ordinal);
        Assert.Contains("CollectLabel!!(", printed, StringComparison.Ordinal);

        // Add(3): total += CollectLabel(3)=6 -> AddPatternSwitch(2) -> Add(1):
        // total += CollectLabel(1)=2 (total=8) -> AddPatternSwitch(0): depth
        // not > 0, stop. Final total = 8.
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(3)", "8");
    }

    [Fact]
    public void GenericMemberOfMutualRecursionCycle_StaysOffNullableScheme()
    {
        // Carve-out guard (#4197 scope, #4198 follow-up): a generic local
        // function's type parameters cannot be expressed on a function-typed
        // local (`(...) -> R)?`), so `RegisterCapturingRecursiveLocalFunctions`
        // must never claim one, whole cycle included, even after #4197
        // widened the gate to every `group.Count > 1` SCC. This asserts the
        // NEGATIVE property #4197 could have broken — the widened gate does
        // not swallow a generic cycle into `var`/`!!` output.
        //
        // NOTE: this does NOT assert the pair ends up cleanly lifted to
        // `__local_` either. A generic local function's recursive call site
        // resolves (via Roslyn) to a CONSTRUCTED method symbol, which never
        // equals the UNCONSTRUCTED declaration `GetDeclaredSymbol` returns —
        // so BOTH `RegisterCapturingRecursiveLocalFunctions` and
        // `RegisterRecursiveLocalFunctionLifts` fail to see the recursive
        // edge at all, and this shape falls through to a plain `let` binding
        // that does not bind in gsc (GS0130). That gap is pre-existing,
        // independent of #4197 (verified unchanged with and without this
        // issue's fix), and out of this issue's scope — see #4198.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(
            @"
namespace Demo
{
    public class C
    {
        public string Run(int value)
        {
            return Helper(value, 2);

            static string Helper<T>(T x, int n) => n <= 0 ? x.ToString() : Other(x, n - 1);
            static string Other<T>(T x, int n) => Helper(x, n - 1);
        }
    }
}",
            roundTripOnlyReason: "pre-existing gap (generic recursive local function symbol identity, #4198) — not fixed by #4197");

        Assert.DoesNotContain("var Helper", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("var Other", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Helper!!(", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Other!!(", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void RefReturningMemberOfMutualRecursionCycle_StillLiftsToSyntheticHelper()
    {
        // Carve-out regression guard (#4197 scope, #1900/#4198 follow-up): a
        // ref-returning local function has no G# function-literal form, so a
        // mutual-recursion cycle that passes through one must still lift to
        // `__local_` — #4197's widened gate must not touch it. The recursive
        // step is a plain (non-ref) call rather than `return ref Other(...)`
        // to sidestep the unrelated, pre-existing #1987 "ref over a call
        // result" gap, isolating this test to the #4197 carve-out itself.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Run(int value)
        {
            int[] data = new int[] { 10, 20, 30 };
            return Helper(data, value);

            static ref int Helper(int[] a, int n)
            {
                if (n > 0)
                {
                    Other(a, n - 1);
                }

                return ref a[0];
            }

            static ref int Other(int[] a, int n)
            {
                if (n > 0)
                {
                    Helper(a, n - 1);
                }

                return ref a[1];
            }
        }
    }
}");

        Assert.Contains("__local_Run_Helper", printed, StringComparison.Ordinal);
        Assert.Contains("__local_Run_Other", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("var Helper", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("var Other", printed, StringComparison.Ordinal);

        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().Run(2)");
    }

    [Fact]
    public void DefaultParameterNonRecursiveDependency_StaysLiftedNotFolded()
    {
        // Carve-out regression guard found via PR #4200's own "hot-core
        // translation guard" CI job (a separate root cause from that PR's
        // Copilot review comment): #4197's fold-BFS pulls a non-recursive
        // callee reachable only from a claimed capturing SCC into the SAME
        // forward-declared nullable-function-local group. That scheme's
        // declaration shape — `var Name (Params -> R)? = nil` — is a
        // structural arrow/delegate type with no way to express a default
        // parameter value, and every call site is rewritten to
        // `Name!!(args)` (a delegate-typed invocation), which cannot fall
        // back to a default the way a real method call can. Real corpus
        // shape (`src/Core/CodeAnalysis/Binding/Binder.cs`'s
        // `FindTopLevelBaseIndex`, called with all 3 arguments from
        // `AddNestedBaseDependencies` but only 2 from `AddBaseFirst`, relying
        // on the third parameter's default): folding it in produced
        // `GS0144: Function 'FindTopLevelBaseIndex!!' requires 3 arguments
        // but was given 2` at the `AddBaseFirst`-shaped call site. A
        // default-parameter candidate must stay on the `__local_` lift path
        // instead, which lifts to a REAL method declaration that natively
        // supports default parameter values — both the 3-argument and the
        // 2-argument (default-relying) call sites keep working.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int total = 0;

            void Add(int depth)
            {
                total += CollectLabel(depth);
                if (depth > 0)
                {
                    AddPatternSwitch(depth - 1);
                }
            }

            void AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    Add(depth - 1);
                }
            }

            int CollectLabel(int depth, int bonus = 10)
            {
                return (depth * 2) + bonus;
            }

            Add(seed);
            System.Console.WriteLine(total);
            return total;
        }
    }
}");

        // The capturing `Add`/`AddPatternSwitch` cycle is unaffected — still
        // the real-named nullable scheme, same as `CapturingCycleNonRecursiveDependency_FoldsIntoSameGroup_NotLifted`.
        Assert.Contains("var Add", printed, StringComparison.Ordinal);
        Assert.Contains("var AddPatternSwitch", printed, StringComparison.Ordinal);
        Assert.Contains("Add!!(", printed, StringComparison.Ordinal);
        Assert.Contains("AddPatternSwitch!!(", printed, StringComparison.Ordinal);

        // `CollectLabel` — the default-parameter non-recursive dependency —
        // must NOT be folded into that group; it stays lifted to a synthetic
        // helper (a real method, defaults and all).
        Assert.DoesNotContain("var CollectLabel", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("CollectLabel!!(", printed, StringComparison.Ordinal);
        Assert.Contains("__local_Project_CollectLabel", printed, StringComparison.Ordinal);

        // Add(3): total += CollectLabel(3, 10)=16 -> AddPatternSwitch(2) ->
        // Add(1): total += CollectLabel(1, 10)=12 (total=28) ->
        // AddPatternSwitch(0): depth not > 0, stop. Final total = 28.
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(3)", "28");
    }

    [Fact]
    public void DefaultParameterCycleMember_KeepsRealNames_WholeGroupIncluded()
    {
        // Regression for the #4200 follow-up: the default-parameter carve-out
        // that `DefaultParameterNonRecursiveDependency_StaysLiftedNotFolded`
        // pins was applied to the SCC-detection graph itself, not just to the
        // fold-BFS — so a default-parameter local function that is a CORE
        // MEMBER of a cycle vanished from cycle detection, and the ENTIRE
        // connected component (cycle members and their folded helpers alike)
        // fell through to the `__local_` lift path.
        //
        // Real corpus shape, measured on the nightly gate after #4200 merged
        // (`src/Core/CodeAnalysis/Binding/ControlFlowGraph.cs`'s
        // `ProjectRegionsForDefiniteReturn`): `void Add(BoundStatement, Action<BoundStatement>? routeTransfer = null)`
        // is mutually recursive with `AddPatternSwitch`/`AddTry` and captures
        // outer state — the ORIGINAL #3399 shape, correctly on the nullable
        // scheme since long before #4197. Every one of its call sites already
        // passes both arguments explicitly, so the default is never actually
        // exercised by omission; declaring one was enough to lift all SEVEN
        // functions in that method (`ControlFlowGraph.gs` went from 4
        // `__local_` helpers to 7, breaching the corpus `liftedLocalCeiling`).
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int total = 0;

            void Add(int depth, int bonus = 10)
            {
                total += bonus + NewLabel(depth);
                if (depth > 0)
                {
                    AddPatternSwitch(depth - 1);
                }
            }

            void AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    Add(depth - 1, 0);
                }
            }

            int NewLabel(int depth)
            {
                return depth * 2;
            }

            Add(seed, 5);
            System.Console.WriteLine(total);
            return total;
        }
    }
}");

        // The whole component keeps its real names: the two cycle members AND
        // the non-recursive helper folded in behind them.
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("var Add", printed, StringComparison.Ordinal);
        Assert.Contains("var AddPatternSwitch", printed, StringComparison.Ordinal);
        Assert.Contains("var NewLabel", printed, StringComparison.Ordinal);
        Assert.Contains("Add!!(", printed, StringComparison.Ordinal);
        Assert.Contains("AddPatternSwitch!!(", printed, StringComparison.Ordinal);
        Assert.Contains("NewLabel!!(", printed, StringComparison.Ordinal);

        // Add(3, 5): total += 5 + NewLabel(3)=6 (total=11) ->
        // AddPatternSwitch(2) -> Add(1, 0): total += 0 + NewLabel(1)=2
        // (total=13) -> AddPatternSwitch(0): depth not > 0, stop. Total = 13.
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(3)", "13");
    }

    [Fact]
    public void DefaultParameterCycleMember_OmittedArgumentIsMaterializedAtCallSite()
    {
        // The other half of the same fix: a claimed cycle member whose default
        // IS relied upon by omission. `Name!!(args)` is a structural
        // function-type invocation — gsc's arrow type carries parameter TYPES
        // only, never defaults — so the omitted argument cannot fall back the
        // way a real method call can (GS0144 "requires 2 arguments but was
        // given 1"). Roslyn has already resolved the omission to the constant
        // default, so the call site materializes it explicitly, exactly as the
        // `__local_` lift path and the #1901 lambda-default path already do.
        // A NAMED call site normalizes to the same positional form, since a
        // structural arrow type has no parameter names to bind against.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int total = 0;

            void Add(int depth, int bonus = 10)
            {
                total += bonus;
                if (depth > 0)
                {
                    AddPatternSwitch(depth - 1);
                }
            }

            void AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    Add(depth - 1);
                }
            }

            Add(seed, 5);
            Add(depth: 0);
            System.Console.WriteLine(total);
            return total;
        }
    }
}");

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("var Add", printed, StringComparison.Ordinal);
        Assert.Contains("var AddPatternSwitch", printed, StringComparison.Ordinal);

        // Both omitting call sites carry the materialized default, and the
        // named one is positional (no `depth:`/`bonus:` through the arrow).
        Assert.Contains("Add!!(depth - 1, 10)", printed, StringComparison.Ordinal);
        Assert.Contains("Add!!(0, 10)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("depth:", printed, StringComparison.Ordinal);

        // Add(2, 5): total = 5 -> AddPatternSwitch(1) -> Add(0) [default 10]:
        // total = 15, depth not > 0, stop. Then Add(depth: 0) [default 10]:
        // total = 25.
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(2)", "25");
    }

    [Fact]
    public void DefaultParameterCycleMember_OutOfOrderNamedArgumentBindsByParameterOrdinal()
    {
        // PR #4211 review (Copilot). `IInvocationOperation.Arguments` is in
        // EVALUATION order, not parameter order. Verified directly against this
        // repo's Roslyn (Microsoft.CodeAnalysis.CSharp 5.6.0): for
        // `void Add(int depth = 0, int bonus = 10)`, the call `Add(bonus: X)`
        // arrives as
        //   [0] param=bonus ordinal=1 kind=Explicit
        //   [1] param=depth ordinal=0 kind=DefaultValue
        // so the ORIGINAL positional walk emitted `Add!!(X, 10)` — silently
        // binding the caller's value to `depth` and the `depth` default to
        // `bonus`. Nothing failed to compile; only the answer was wrong.
        // Slots are now addressed by `IParameterSymbol.Ordinal`.
        //
        // `Next()` is side-effecting so the run also pins that the reordering
        // neither drops nor duplicates the caller's expression.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int total = 0;
            int ticks = 0;

            int Next()
            {
                ticks++;
                return 7;
            }

            void Add(int depth = 0, int bonus = 10)
            {
                total = (total * 100) + (depth * 10) + bonus;
                if (depth > 0)
                {
                    AddPatternSwitch(depth - 1);
                }
            }

            void AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    Add(depth - 1);
                }
            }

            Add(bonus: Next());
            System.Console.WriteLine(total + "":"" + ticks);
            return total;
        }
    }
}");

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("var Add", printed, StringComparison.Ordinal);

        // `Next()` lands in the `bonus` slot (ordinal 1), the omitted `depth`
        // default in slot 0 — NOT the other way round.
        Assert.Contains("Add!!(0, Next", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Add!!(Next", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("bonus:", printed, StringComparison.Ordinal);

        // depth = 0 (default), bonus = 7 -> total = 7; `Next()` ran once.
        // The pre-fix emission `Add!!(Next!!(), 10)` instead recursed from
        // depth = 7 and printed a completely different total.
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(0)", "7:1");
    }

    [Fact]
    public void DefaultParameterCycleMember_PermutedNamedArgumentsKeepSourceEvaluationOrder()
    {
        // The same fix's other half. Reassembling by ordinal is only half the
        // job: when TWO explicit arguments are named out of declared order,
        // emitting them straight into their ordinal slots would also swap the
        // order in which they EVALUATE, and C# §12.6.2.2 fixes that to source
        // order. Each non-trivial explicit operand is therefore spilled to a
        // `let __spillN` in source order first, and the positional call site
        // references the spills.
        //
        // The two printed numbers separate the two failure modes exactly:
        //   total pins WHICH PARAMETER each value bound to,
        //   ticks pins the ORDER the two `Next` calls ran in.
        // Pre-fix (positional walk) printed "792:79" — right order, wrong
        // binding. A naive ordinal sort with no spill would print "927:97" —
        // right binding, reversed side effects. Only "927:79" is C#.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int total = 0;
            int ticks = 0;

            int Next(int weight)
            {
                ticks = (ticks * 10) + weight;
                return weight;
            }

            void Add(int a = 1, int b = 2, int c = 3)
            {
                total = (total * 1000) + (a * 100) + (b * 10) + c;
                if (a > 100)
                {
                    AddPatternSwitch(a - 1);
                }
            }

            void AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    Add(depth - 1);
                }
            }

            Add(c: Next(7), a: Next(9));
            System.Console.WriteLine(total + "":"" + ticks);
            return total;
        }
    }
}");

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);

        // Spilled in SOURCE order (`Next(7)` first), then bound by ordinal:
        // a = __spill1 (9), b = the omitted default 2, c = __spill0 (7).
        Assert.Contains("__spill0 = Next", printed, StringComparison.Ordinal);
        Assert.Contains("__spill1 = Next", printed, StringComparison.Ordinal);
        Assert.Contains("Add!!(__spill1, 2, __spill0)", printed, StringComparison.Ordinal);

        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(0)", "927:79");
    }

    [Fact]
    public void VariadicCycleMember_StaysOnLiftPath()
    {
        // PR #4211 review (Copilot), the other finding. cs2gs's
        // `ArrowTypeReference` carries parameter TYPES only — it has no
        // variadic flag — and `MapParameter` maps a `params T[]` to its ELEMENT
        // type behind a `...` carrier. So `AddGroupMember` would forward-declare
        // `var Add ((int32, int32) -> void)?` for a literal that is really
        // `func (depth int32, xs ...int32)`: two distinct gsc function types
        // ("Cannot convert type '(int32, ...int32) -> void' to
        // '((int32, int32) -> void)?'"), plus "Function 'Add!!' requires 2
        // arguments but was given 3" at every expanded call site. Unlike a
        // default parameter value this is not repairable at the call site — the
        // DECLARATION is already the wrong type — so a variadic member keeps its
        // whole cycle on the `__local_` lift path, whose real method declaration
        // carries `params` natively.
        //
        // (gsc itself is not the limitation: a hand-written
        // `var f ((int32, ...int32) -> void)? = nil` declares, binds and runs.
        // Teaching `ArrowTypeReference` variadic shape is the follow-up.)
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int Add(int depth, params int[] xs)
            {
                int sum = 0;
                foreach (int x in xs) { sum += x; }
                if (depth > 0)
                {
                    sum += AddPatternSwitch(depth - 1);
                }

                return sum;
            }

            int AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    return Add(depth - 1, 1, 2);
                }

                return 0;
            }

            int result = Add(seed, 3, 4);
            System.Console.WriteLine(result);
            return result;
        }
    }
}");

        // The whole cycle stays on `__local_`, exactly as the generic and
        // ref-returning carve-outs above do.
        Assert.Contains("__local_Project_Add", printed, StringComparison.Ordinal);
        Assert.Contains("__local_Project_AddPatternSwitch", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Add!!(", printed, StringComparison.Ordinal);

        // The lifted real method keeps the variadic parameter natively.
        Assert.Contains("xs ...int32", printed, StringComparison.Ordinal);

        // Add(2, 3, 4) = 7 + AddPatternSwitch(1) -> Add(0, 1, 2) = 3. Total 10.
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(2)", "10");
    }

    [Fact]
    public void RefParameterCycleMember_StaysOnLiftPath()
    {
        // PR #4211 review round 3 (Copilot), finding 1 — reported as an
        // evaluation-order hazard in the claimed-cycle argument reassembly
        // (`ref slots[NextIndex()]` moving relative to a spilled sibling).
        // The reassembly is not where this breaks. A ref-kind parameter is a
        // DECLARATION-side impossibility, exactly like `params` above:
        // `ArrowTypeReference` carries parameter types only and has no
        // ref-kind, so `AddGroupMember` declared
        // `var Add ((int32, int32) -> void)?` for a literal that is really
        // `func (depth int32, ref cell int32)` — `(int32, *int32) -> void`.
        //
        // Measured on this branch before the fix, gsc rejected it
        // unconditionally:
        //   Cannot convert type '(int32, int32) -> void'
        //       to '((int32, int32) -> void)?'.
        //   Cannot convert type '*int32' to 'int32'.   (x2, the `&x` call sites)
        // for `ref`, `out` (`*?`) and `in` alike, with or without a default
        // parameter and with or without a named call site. There is
        // therefore no reachable "silently changing side effects": the program
        // never compiles. The fix is the same carve-out `params` got, which
        // additionally makes a ref-kind argument unreachable in
        // `TranslateClaimedLocalFunctionArgumentsWithDefaults`.
        //
        // The call site below is Copilot's exact shape — a permuted named call
        // passing `ref slots[Idx()]` alongside an omitted default. On the
        // `__local_` path it now takes, the lift keeps the `name:` wrappers
        // (a real method HAS parameter names), so the emitted call is
        // `__local_Project_Add(cell: &slots[Idx()], a: Val(), 100)` and the
        // binding is right: cell aliases slots[1], a = 5, b = 100 => 105.
        //
        // `order` prints 21, not C#'s 12, and that is a SEPARATE gsc-side gap
        // with nothing to do with cs2gs: gsc evaluates an out-of-declared-order
        // NAMED argument list in source order for by-value operands but
        // evaluates a `&` operand at its PARAMETER position. Reduced to three
        // SEPARATE hand-written G# programs, no translator involved, each with
        // its own callee — `Idx`/`Val` fold a digit into `order`:
        //   func Add(a int32, ref cell int32, b int32 = 100)
        //     Add(cell: &slots[Idx()], a: Val(), 100)  => order 21  (WRONG)
        //   func Add(a int32, c int32)
        //     Add(c: Idx(), a: Val())                  => order 12  (by-value
        //                                                            named, ok)
        //   func RefFirst(ref cell int32, a int32)
        //     RefFirst(&slots[Idx()], Val())           => order 12  (positional
        //                                                            ref, ok)
        // Pinned here as the tripwire for that follow-up: when gsc starts
        // ordering `&` operands by source position this assertion flips to
        // "105:12" and this comment comes out.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int order = 0;
            int[] slots = new int[3];

            int Idx()
            {
                order = (order * 10) + 1;
                return 1;
            }

            int Val()
            {
                order = (order * 10) + 2;
                return 5;
            }

            void Add(int a, ref int cell, int b = 100)
            {
                cell = a + b;
                if (a > 1000)
                {
                    AddPatternSwitch(a - 1);
                }
            }

            void AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    int t = 0;
                    Add(depth - 1, ref t);
                }
            }

            Add(cell: ref slots[Idx()], a: Val());
            System.Console.WriteLine(slots[1] + "":"" + order);
            return 0;
        }
    }
}");

        // The whole cycle stays on `__local_`, whose REAL method declaration
        // carries `ref` natively — nothing ever declares an arrow type for it.
        Assert.Contains("__local_Project_Add", printed, StringComparison.Ordinal);
        Assert.Contains("__local_Project_AddPatternSwitch", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Add!!(", printed, StringComparison.Ordinal);
        Assert.Contains("ref cell int32", printed, StringComparison.Ordinal);

        // a = 5, b = 100 (default), cell = slots[1] = 105 — the binding this
        // carve-out exists to get right. `order` is the gsc-side tripwire
        // documented above; before the carve-out this snippet did not compile
        // at all, so there was no order to get wrong.
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(0)", "105:21");
    }

    [Fact]
    public void OutParameterCycleMember_StaysOnLiftPath()
    {
        // The `out` half of the carve-out above: the erased arrow type made the
        // call sites fail as "Cannot convert type '*?' to 'int32'" (the `out`
        // address form has no declared pointee yet at the call site), on top of
        // the same declaration mismatch. Kept separate because an `out`
        // argument also flows a DECLARATION expression (`out int t`) through
        // the `__local_` lift rewrite.
        //
        // It also carries NO default parameter, which makes it the half of the
        // gap that PREDATES this PR: it fails identically against pre-PR
        // e815bb76. The ref-plus-default shape in the test above does NOT fail
        // there, because the blanket `HasExplicitDefaultValue` exclusion that
        // #4197's fix (e1c4c1d9) correctly removed used to keep it off the
        // scheme by accident — removing it exposed that shape for the first
        // time. One carve-out closes both halves.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int total = 0;

            void Add(int depth, out int cell)
            {
                cell = depth;
                total += cell;
                if (depth > 0)
                {
                    AddPatternSwitch(depth - 1);
                }
            }

            void AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    Add(depth - 1, out int t);
                }
            }

            Add(seed, out int c);
            System.Console.WriteLine(total + "":"" + c);
            return total;
        }
    }
}");

        Assert.Contains("__local_Project_Add", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Add!!(", printed, StringComparison.Ordinal);

        // Add(2) -> total 2 -> AddPatternSwitch(1) -> Add(0) -> total 2. c = 2.
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(2)", "2:2");
    }

    [Fact]
    public void DefaultParameterCycleMember_PermutedNamedArgumentsSnapshotBareIdentifiers()
    {
        // PR #4211 review round 3 (Copilot), finding 2 — and the one the
        // previous round's spill genuinely missed. `SpillOperand` short-circuits
        // on `IsTrivialOperand`, which answers "is DUPLICATING this safe?". That
        // is the wrong question when the reassembly REORDERS instead of
        // duplicating: `x` is still read exactly once, just at the wrong time.
        //
        // `Add(c: x, a: MutateX())` must read `x` (5) before `MutateX()` sets it
        // to 99, so C# binds a = 1 (default), b = 2 (default), c = 5 => 125.
        // Before the fix this branch emitted
        //     let __spill0 = MutateX()
        //     Add!!(__spill0, 2, x)
        // which compiled, ran, and printed 219 (c = 99) — a silently wrong
        // answer, the exact failure mode Copilot described. Every explicit
        // operand that is not a literal or a type name is now snapshotted.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int total = 0;
            int x = 5;

            int MutateX()
            {
                x = 99;
                return 1;
            }

            void Add(int a = 1, int b = 2, int c = 3)
            {
                total = (total * 1000) + (a * 100) + (b * 10) + c;
                if (a > 100)
                {
                    AddPatternSwitch(a - 1);
                }
            }

            void AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    Add(depth - 1);
                }
            }

            Add(c: x, a: MutateX());
            System.Console.WriteLine(total);
            return total;
        }
    }
}");

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);

        // `x` is snapshotted FIRST (source order), then `MutateX()`; the
        // reassembled call references both spills and no bare `x`.
        Assert.Contains("let __spill0 = x", printed, StringComparison.Ordinal);
        Assert.Contains("let __spill1 = MutateX", printed, StringComparison.Ordinal);
        Assert.Contains("Add!!(__spill1, 2, __spill0)", printed, StringComparison.Ordinal);

        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(0)", "125");
    }

    [Fact]
    public void DefaultParameterCycleMember_PermutedNamedArgumentsKeepLiteralsEmbedded()
    {
        // The snapshot above is deliberately not universal: a literal cannot be
        // observed changing, so it stays embedded and the output keeps only the
        // temps it needs. `Add(c: 7, a: MutateX())` binds c = 7 regardless of
        // when it is "read", so only `MutateX()` spills.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(@"
namespace Demo
{
    public class Builder
    {
        public int Project(int seed)
        {
            int total = 0;
            int x = 5;

            int MutateX()
            {
                x = 99;
                return 1;
            }

            void Add(int a = 1, int b = 2, int c = 3)
            {
                total = (total * 1000) + (a * 100) + (b * 10) + c;
                if (a > 100)
                {
                    AddPatternSwitch(a - 1);
                }
            }

            void AddPatternSwitch(int depth)
            {
                if (depth > 0)
                {
                    Add(depth - 1);
                }
            }

            Add(c: 7, a: MutateX());
            System.Console.WriteLine(total + "":"" + x);
            return total;
        }
    }
}");

        Assert.Contains("Add!!(__spill0, 2, 7)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill1", printed, StringComparison.Ordinal);

        // a = 1, b = 2, c = 7 => 127; `MutateX()` still ran (x = 99).
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(0)", "127:99");
    }
}
