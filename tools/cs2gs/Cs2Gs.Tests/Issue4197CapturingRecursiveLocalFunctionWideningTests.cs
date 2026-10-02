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
/// The later #4302 coverage in this file also pins retirement of the
/// <c>__local_</c> family: homogeneous excluded signatures use native
/// direct-local groups, while compiler-deferred mixed groups keep readable
/// source-named member helpers.
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
    public void GenericMemberOfMutualRecursionCycle_UsesNativeGenericGroup()
    {
        // Carve-out guard (#4197 scope, #4198 follow-up): a generic local
        // function's type parameters cannot be expressed on a function-typed
        // local (`(...) -> R)?`), so `RegisterCapturingRecursiveLocalFunctions`
        // must never claim one, whole cycle included, even after #4197
        // widened the gate to every `group.Count > 1` SCC. This asserts the
        // NEGATIVE property #4197 could have broken — the widened gate does
        // not swallow a generic cycle into `var`/`!!` output.
        //
        // #4219: graph edges use declaration identity even for constructed
        // generic calls. Keep the qualified lift fallback and execute it;
        // merely missing a cycle must never masquerade as native support.
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
}");

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("let Helper[T] = func", printed, StringComparison.Ordinal);
        Assert.Contains("let Other[T] = func", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("var Helper", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run(42))", "42");
    }

    [Fact]
    public void RefReturningMemberOfMutualRecursionCycle_UsesNativeRefGroup()
    {
        // Carve-out regression guard (#4197 scope, #1900/#4198 follow-up):
        // #4302 emits native direct-local groups for static, non-generic
        // ref-returning local functions. The recursive
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

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("let Helper = func (a []int32, n int32) ref int32", printed, StringComparison.Ordinal);
        Assert.Contains("let Other = func (a []int32, n int32) ref int32", printed, StringComparison.Ordinal);

        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().Run(2)");
    }

    [Fact]
    public void ExpressionBodiedRefReturningLocalFunction_UsesNativeLiteral()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run() {
                        int[] data = new int[] { 10 };
                        static ref int At(int[] values, int index) => ref values[index];
                        ref int alias = ref At(data, 0);
                        alias = 42;
                        return data[0];
                    }
                }
            }
            """);

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("let At = func (values []int32, index int32) ref int32", printed, StringComparison.Ordinal);
        Assert.Contains("return ref values[index]", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C().Run())",
            "42");
    }

    [Fact]
    public void GenericRefReturningLocalFunction_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run() {
                        int[] data = new int[] { 10 };
                        static ref T At<T>(T[] values, int index) => ref values[index];
                        return At<int>(data, 0);
                    }
                }
            }
            """, "generic ref-returning function literals remain deliberately unsupported");

        Assert.Contains(
            "// unsupported: ref-returning local function 'At'",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("let At[T] = func", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void CapturingRefReturningLocalFunction_RemainsALoudGap()
    {
        // Issue #4580: gsc emits an access-violating program for a capturing
        // ref-returning function literal, so cs2gs keeps that shape off the
        // native path and reports it until gsc is fixed.
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int seed) {
                        int[] data = new int[] { seed };
                        ref int At() => ref data[0];
                        At() = 5;
                        return data[0];
                    }
                }
            }
            """, "capturing ref-returning function literals stay guarded pending #4580");

        Assert.Contains(
            "// unsupported: ref-returning local function 'At'",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("let At = func", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void RefReturningLocalFunctionUsedAsDelegate_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public delegate ref int RefGetter(int[] values);
                public class C {
                    public int Run() {
                        int[] data = new int[] { 10 };
                        RefGetter getter = At;
                        return getter(data);
                        static ref int At(int[] values) => ref values[0];
                    }
                }
            }
            """, "G# does not convert ref-returning function literals to delegate values");

        Assert.Contains(
            "// unsupported: ref-returning local function 'At'",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("let At = func", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void RefReturningSwitchSectionLocalUsedAsDelegate_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public delegate ref int RefGetter(int[] values);
                public class C {
                    public int Run(int value) {
                        int[] data = new int[] { 10 };
                        switch (value) {
                            case 0:
                                RefGetter getter = At;
                                return getter(data);
                                static ref int At(int[] values) => ref values[0];
                            default:
                                return 0;
                        }
                    }
                }
            }
            """, "switch-section ref-returning function literals cannot become delegate values");

        Assert.Contains(
            "// unsupported: ref-returning local function 'At'",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("let At = func", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void RefReturningLocalFunctionNameof_DoesNotCountAsDelegateUse()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run() {
                        int[] data = new int[] { 10 };
                        _ = nameof(At);
                        return At(data);
                        static ref int At(int[] values) => ref values[0];
                    }
                }
            }
            """);

        Assert.Contains("let At = func (values []int32) ref int32", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "// unsupported: ref-returning local function 'At'",
            printed,
            StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void RefReturningLocalFunctionReferencedFromAnotherSwitchSection_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        int[] data = new int[] { 10 };
                        switch (value) {
                            case 0:
                                static ref int At(int[] values) => ref values[0];
                                return At(data);
                            case 1:
                                return At(data);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """, "switch sections cannot share a direct ref-returning function literal");

        Assert.Contains(
            "// unsupported: ref-returning local function 'At'",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("let At = func", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void RefReturningLocalFunctionNameofFromAnotherSwitchSection_IsHarmless()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        int[] data = new int[] { 10 };
                        switch (value) {
                            case 0:
                                static ref int At(int[] values) => ref values[0];
                                return At(data);
                            case 1:
                                _ = nameof(At);
                                return 0;
                            default:
                                return 0;
                        }
                    }
                }
            }
            """);

        Assert.Contains("let At = func (values []int32) ref int32", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "// unsupported: ref-returning local function 'At'",
            printed,
            StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void RefReturningLocalFunctionCalledBeforeDeclarationInSwitchSection_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        int[] data = new int[] { 10 };
                        switch (value) {
                            case 0:
                                int result = At(data);
                                static ref int At(int[] values) => ref values[0];
                                return result;
                            default:
                                return 0;
                        }
                    }
                }
            }
            """, "switch sections do not hoist direct ref-returning function literals");

        Assert.Contains(
            "// unsupported: ref-returning local function 'At'",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("let At = func", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void AdjacentCapturingDelegateLocal_IsNotSwallowedByNativeGroup()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    private static int Apply(System.Func<int, int> callback) => callback(2);

                    public int Run(int seed) {
                        int Callback(int value) => value + seed;
                        static int First(int value, params int[] rest) =>
                            value == 0 ? 0 : Second(value - 1);
                        static int Second(int value) =>
                            value == 0 ? 0 : First(value - 1);
                        return Apply(Callback) + First(2);
                    }
                }
            }
            """);

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("let Callback = func", printed, StringComparison.Ordinal);
        Assert.Contains("func First(", printed, StringComparison.Ordinal);
        Assert.Contains("func Second(", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C().Run(40))",
            "42");
    }

    [Fact]
    public void LeadingAdjacentDelegateLocal_IsNotSwallowedByNativeGroup()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    private static int Apply(System.Func<int, int> callback) => callback(2);

                    public int Run(int seed) {
                        int applied = Apply(Prefix);
                        int Prefix(int value) => value + seed;
                        static int First(int value, params int[] rest) =>
                            value == 0 ? 0 : Second(value - 1);
                        static int Second(int value) =>
                            value == 0 ? 0 : First(value - 1);
                        return applied + First(2);
                    }
                }
            }
            """);

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("let Prefix = func", printed, StringComparison.Ordinal);
        Assert.Contains("func First(", printed, StringComparison.Ordinal);
        Assert.Contains("func Second(", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C().Run(40))",
            "42");
    }

    [Fact]
    public void CapturingRecursiveLocalUsedAsDelegate_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        int offset = 1;
                        System.Func<int, int> callback = First;
                        return callback(value);
                        int First(int n) => n == 0 ? offset : Second<int>(n - 1);
                        int Second<T>(int n) => n == 0 ? offset : First(n - 1);
                    }
                }
            }
            """, "capturing recursive member helpers require explicit capture arguments");

        Assert.Contains(
            "// unsupported: capturing recursive local function value 'First'",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void MixedRecursiveGroupInSwitchSection_UsesMemberFallback()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        switch (value) {
                            case 0:
                            case int n when n > 5:
                                return First(value);
                                static int First(int n) => n == 0 ? 0 : Second<int>(n - 1);
                                static int Second<T>(int n) => First(n);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """);

        Assert.Contains("// lifted static local function First", printed, StringComparison.Ordinal);
        Assert.Contains("// lifted static local function Second", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void MixedRecursiveGroupDeclaredInLaterSwitchSection_IsPreRegistered()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        switch (value) {
                            case 0:
                                return First(value);
                            case 1:
                                static int First(int n) => n == 0 ? 0 : Second<int>(n - 1);
                                static int Second<T>(int n) => First(n);
                                return First(value);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """);

        Assert.Contains("// lifted static local function First", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void HomogeneousGenericGroupCalledFromEarlierSwitchSection_UsesMemberFallback()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        switch (value) {
                            case 0:
                                return First<int>(value);
                            case 1:
                                static int First<T>(int n) => n == 0 ? 0 : Second<T>(n - 1);
                                static int Second<U>(int n) => n == 0 ? 0 : First<U>(n - 1);
                                return First<int>(value);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """);

        Assert.Contains("// lifted static local function First", printed, StringComparison.Ordinal);
        Assert.Contains("// lifted static local function Second", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void SelfRecursiveLocalCalledFromEarlierSwitchSection_UsesMemberFallback()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        switch (value) {
                            case 0:
                                return First(value);
                            case 1:
                                static int First(int n) => n == 0 ? 0 : First(n - 1);
                                return First(value);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """);

        Assert.Contains("// lifted static local function First", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void SelfRecursiveLocalForcedAcrossSwitchWithMethodTypeParameter_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run<T>(T value, int depth, int mode) {
                        switch (mode) {
                            case 0:
                                return First(value, depth);
                            case 1:
                                static int First(T item, int n) =>
                                    n == 0 ? 0 : First(item, n - 1);
                                return First(value, depth);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ConstrainedGenericRecursiveGroup_UsesMemberFallback()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(System.IDisposable value, int depth) {
                        return First<System.IDisposable>(value, depth);

                        static int First<T>(T item, int n) where T : System.IDisposable {
                            item.Dispose();
                            return n == 0 ? 0 : Second<T>(item, n - 1);
                        }

                        static int Second<U>(U item, int n) where U : System.IDisposable {
                            item.Dispose();
                            return n == 0 ? 0 : First<U>(item, n - 1);
                        }
                    }
                }
            }
            """);
        Assert.Contains("// lifted static local function First", printed, StringComparison.Ordinal);
        Assert.Contains("// lifted static local function Second", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void MixedRecursiveGroupSplitAcrossSwitchSections_UsesMemberFallback()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        switch (value) {
                            case 0:
                                static int First(int n) => n == 0 ? 0 : Second<int>(n - 1);
                                return First(value);
                            case 1:
                                static int Second<T>(int n) => n == 0 ? 0 : First(n - 1);
                                return Second<int>(value);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """);

        Assert.Contains("// lifted static local function First", printed, StringComparison.Ordinal);
        Assert.Contains("// lifted static local function Second", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void CapturingRecursiveDelegateGroupInOneSwitchSection_UsesNullableGroup()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        switch (value) {
                            case 0:
                                int First(int n) => n == 0 ? value : Second(n - 1);
                                System.Func<int, int> callback = First;
                                int Second(int n) => n == 0 ? value : First(n - 1);
                                return callback(value);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """);

        Assert.Contains("var First", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("// lifted recursive local function First", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void CapturingGenericGroupReferencingEnclosingTypeParameter_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run<T>(T value, int depth) {
                        int offset = 1;
                        int First<U>(U item, int n) =>
                            n == 0 ? offset + value.GetHashCode() : Second<U>(item, n - 1);
                        int Second<V>(V item, int n) =>
                            n == 0 ? offset : First<V>(item, n - 1);
                        return First<T>(value, depth);
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void SelfRecursiveCapturingGenericReferencingEnclosingTypeParameter_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run<T>(T value, int depth) {
                        int First<U>(U item, int n) =>
                            n == 0 ? value.GetHashCode() : First<U>(item, n - 1);
                        return First<T>(value, depth);
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void GenericRecursiveGroupCapturingInstanceReceiver_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    private int offset;

                    public int Run<T>(T value, int depth) {
                        int First<U>(T item, int n) =>
                            n == 0 ? this.offset : Second<U>(item, n - 1);
                        int Second<V>(T item, int n) =>
                            n == 0 ? offset : First<V>(item, n - 1);
                        return First<T>(value, depth);
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void StaticGenericRecursiveGroupUsingPatternInput_RemainsNative()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run<T>(T value, int depth) {
                        static int First<U>(T item, int n) =>
                            item.ToString() is { Length: > 0 } && n > 0
                                ? Second<U>(item, n - 1)
                                : 0;
                        static int Second<V>(T item, int n) =>
                            n > 0 ? First<V>(item, n - 1) : 0;
                        return First<T>(value, depth);
                    }
                }
            }
            """);

        Assert.DoesNotContain("cannot preserve an enclosing type parameter", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void GenericRecursiveGroupImplicitlyCapturingGenericContainingType_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C<T> {
                    private int offset;

                    public int Run(int depth) {
                        int First<U>(U item, int n) =>
                            n == 0 ? offset : Second<U>(item, n - 1);
                        int Second<V>(V item, int n) =>
                            n == 0 ? offset : First<V>(item, n - 1);
                        return First<int>(0, depth);
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void GenericRecursiveGroupUsingStaticMemberOfGenericContainingType_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C<T> {
                    private static int Shared() => 1;

                    public int Run(int depth) {
                        int offset = 1;
                        int First<U>(U item, int n) =>
                            n == 0 ? offset + Shared() : Second<U>(item, n - 1);
                        int Second<V>(V item, int n) =>
                            n == 0 ? offset : First<V>(item, n - 1);
                        return First<int>(0, depth);
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void GenericRecursiveGroupWithTransitivelyCapturedEnclosingTypeParameter_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run<T>(T value, int depth) {
                        int Capture() => value.GetHashCode();
                        int First<U>(U item, int n) =>
                            n == 0 ? Capture() : Second<U>(item, n - 1);
                        int Second<V>(V item, int n) =>
                            n == 0 ? Capture() : First<V>(item, n - 1);
                        return First<T>(value, depth);
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void MixedRecursiveGroupAcrossSwitchSectionsWithEnclosingTypeParameterCapture_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run<T>(T value, int depth, int mode) {
                        switch (mode) {
                            case 0:
                                int First<U>(U item, int n) =>
                                    n == 0 ? value.GetHashCode() : Second<U>(item, n - 1);
                                int Second<V>(V item, int n) =>
                                    n == 0 ? value.GetHashCode() : Third(n - 1);
                                return First<T>(value, depth);
                            case 1:
                                int Third(int n) =>
                                    n == 0 ? value.GetHashCode() : First<T>(value, n - 1);
                                return Third(depth);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CaptureFreeMixedGroupReferencingEnclosingMethodTypeParameter_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run<T>(T value, int depth) {
                        static int First(T item, int n) =>
                            n == 0 ? 0 : Second<T>(item, n - 1);
                        static int Second<U>(T item, int n) =>
                            n == 0 ? 0 : First(item, n - 1);
                        return First(value, depth);
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CaptureFreeGenericGroupForcedAcrossSwitchSectionsWithMethodTypeParameter_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run<T>(T value, int depth, int mode) {
                        switch (mode) {
                            case 0:
                                return First<T>(value, depth);
                            case 1:
                                static int First<U>(T item, int n) =>
                                    n == 0 ? 0 : Second<U>(item, n - 1);
                                static int Second<V>(T item, int n) =>
                                    n == 0 ? 0 : First<V>(item, n - 1);
                                return First<T>(value, depth);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CaptureFreeNonGenericGroupForcedAcrossSwitchSectionsWithMethodTypeParameter_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run<T>(T value, int depth, int mode) {
                        switch (mode) {
                            case 0:
                                return First(value, depth);
                            case 1:
                                static int First(T item, int n) =>
                                    n == 0 ? 0 : Second(item, n - 1);
                                static int Second(T item, int n) =>
                                    n == 0 ? 0 : First(item, n - 1);
                                return First(value, depth);
                            default:
                                return 0;
                        }
                    }
                }
            }
            """, "cannot preserve an enclosing type parameter");

        Assert.Contains(
            "// unsupported: recursive local function 'First' cannot preserve an enclosing type parameter",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CapturingRecursiveLocalUsedAsDelegateFromSiblingSwitchSection_RemainsALoudGap()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        int offset = 1;
                        switch (value) {
                            case 0:
                                int First(int n) => n == 0 ? offset : Second<int>(n - 1);
                                int Second<T>(int n) => n == 0 ? offset : First(n - 1);
                                return First(value);
                            case 1:
                                System.Func<int, int> callback = First;
                                return callback(value);
                            default:
                                return offset;
                        }
                    }
                }
            }
            """, "capturing recursive member helpers require explicit capture arguments");

        Assert.Contains(
            "// unsupported: capturing recursive local function value 'First'",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CapturingRecursiveLocalCalledFromSiblingSwitchSection_UsesLiftedHelper()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int value) {
                        int offset = 1;
                        switch (value) {
                            case 0:
                                int First(int n) => n == 0 ? offset : Second<int>(n - 1);
                                int Second<T>(int n) => n == 0 ? offset : First(n - 1);
                                return First(value);
                            case 1:
                                return First(value);
                            default:
                                return offset;
                        }
                    }
                }
            }
            """);

        Assert.Contains("// lifted recursive local function First", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "// unsupported: capturing recursive local function value 'First'",
            printed,
            StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void CaptureFreeRecursiveFunctionValue_UsesRenamedLiftedHelper()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    private int First(int value) => -value;

                    public int Run(int value) {
                        System.Func<int, int> callback = First;
                        return callback(value);
                        int First(int n) => n == 0 ? 0 : Second<int>(n - 1);
                        int Second<T>(int n) => First(n);
                    }
                }
            }
            """);

        Assert.Contains("func First_2(", printed, StringComparison.Ordinal);
        Assert.Contains("= First_2", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void ClaimedRecursiveGroup_StillLiftsUnsafeRefReturningDependency()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run(int seed) {
                        int[] data = new int[] { 10 };
                        int First(int value) =>
                            value == 0 ? At(data) + seed : Second(value - 1);
                        int Second(int value) =>
                            value == 0 ? 0 : First(value - 1);
                        ref int At(int[] values) => ref values[0];
                        return First(2);
                    }
                }
            }
            """);

        Assert.Contains("var First", printed, StringComparison.Ordinal);
        Assert.Contains("var Second", printed, StringComparison.Ordinal);
        Assert.Contains("func At(", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("unsupported: ref-returning local function 'At'", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C().Run(2))",
            "12");
    }

    [Fact]
    public void DefaultParameterNonRecursiveDependency_FoldsIntoSameGroup()
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
        // default value must therefore be materialized at nullable-group call
        // sites. #4302 folds the helper into the group and performs that
        // materialization explicitly.
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
        // joins the nullable group, with its omitted default materialized at
        // call sites.
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("var CollectLabel", printed, StringComparison.Ordinal);
        Assert.Contains("CollectLabel!!(", printed, StringComparison.Ordinal);

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
    public void VariadicCycleMember_UsesNativeGroup()
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
        // default parameter value this is not repairable at the nullable-group
        // call site. #4302 routes the whole homogeneous cycle through native
        // direct locals, whose declarations carry `params` natively.
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

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("let Add = func (depth int32, xs ...int32)", printed, StringComparison.Ordinal);
        Assert.Contains("let AddPatternSwitch = func", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Add!!(", printed, StringComparison.Ordinal);

        // The direct local keeps the variadic parameter natively.
        Assert.Contains("xs ...int32", printed, StringComparison.Ordinal);

        // Add(2, 3, 4) = 7 + AddPatternSwitch(1) -> Add(0, 1, 2) = 3. Total 10.
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(2)", "10");
    }

    [Fact]
    public void RefParameterCycleMember_UsesNativeGroup()
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
        // never compiles. #4302 routes these signatures through native direct
        // locals instead.
        //
        // The call site below is Copilot's exact shape — a permuted named call
        // passing `ref slots[Idx()]` alongside an omitted default. On the
        // native direct-local path preserves the `name:` wrappers, so the
        // binding is right: cell aliases slots[1], a = 5, b = 100 => 105.
        //
        // `order` is 12, as in C#. It used to print 21, a separate gsc-side
        // gap: gsc evaluated a by-value operand of an out-of-declared-order
        // NAMED argument list in source order, but a `&` operand at its
        // PARAMETER position. Issue #4400 (PR #4411) fixed that: a reordered
        // `&slots[Idx()]` now captures the array and index that select its
        // storage in source order and re-takes the address from them. This
        // assertion was the tripwire for that follow-up.
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

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("let Add = func (a int32, ref cell int32, b int32 = 100)", printed, StringComparison.Ordinal);
        Assert.Contains("let AddPatternSwitch = func", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Add!!(", printed, StringComparison.Ordinal);
        Assert.Contains("Add(cell: &slots[Idx()], a: Val())", printed, StringComparison.Ordinal);
        Assert.Contains("ref cell int32", printed, StringComparison.Ordinal);

        // a = 5, b = 100 (default), cell = slots[1] = 105 — the binding this
        // carve-out exists to get right — and source-order evaluation (12).
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(0)", "105:12");
    }

    [Fact]
    public void OutParameterCycleMember_UsesNativeGroup()
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

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("let Add = func (depth int32, out cell int32)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Add!!(", printed, StringComparison.Ordinal);

        // Add(2) -> total 2 -> AddPatternSwitch(1) -> Add(0) -> total 2. c = 2.
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Builder().Project(2)", "2:2");
    }

    [Fact]
    public void InParameterCycleMember_UsesNativeGroup()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class Builder {
                    public int Project(int seed) {
                        int value = seed;
                        int Add(int depth, in int cell) =>
                            depth == 0 ? cell : Other(depth - 1, in cell);
                        int Other(int depth, in int cell) =>
                            depth == 0 ? cell : Add(depth - 1, in cell);
                        return Add(2, in value);
                    }
                }
            }
            """);

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.Contains("let Add = func (depth int32, in cell int32)", printed, StringComparison.Ordinal);
        Assert.Contains("let Other = func (depth int32, in cell int32)", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(Builder().Project(7))",
            "7");
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
