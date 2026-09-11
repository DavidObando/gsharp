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
}
