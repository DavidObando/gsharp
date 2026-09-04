// <copyright file="Issue2891TryRegionFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2891: definite-return analysis must model try, catch, and finally
/// regions without hiding escaping branches or treating handlers sequentially.
/// </summary>
public class Issue2891TryRegionFlowTests
{
    /// <summary>Gets try-region shapes that must report GS0100.</summary>
    public static IEnumerable<object[]> MissingReturnCases()
    {
        yield return Case("TryFinallyBreak", """
            func F() int32 {
                for {
                    try {
                        break
                    } finally {
                    }
                }
            }
            """);
        yield return Case("TryCatchBreak", """
            import System
            func F() int32 {
                for {
                    try {
                        break
                    } catch (ex Exception) {
                        return 1
                    }
                }
            }
            """);
        yield return Case("TryCatchFinallyBreak", """
            import System
            func F() int32 {
                for {
                    try {
                        break
                    } catch (ex Exception) {
                        return 1
                    } finally {
                    }
                }
            }
            """);
        yield return Case("CatchBreak", """
            import System
            func F() int32 {
                for {
                    try {
                        throw Exception("boom")
                    } catch (ex Exception) {
                        break
                    }
                }
            }
            """);
        yield return Case("FinallyBreak", """
            func F() int32 {
                for {
                    try {
                        return 1
                    } finally {
                        break
                    }
                }
            }
            """);
        yield return Case("LabeledTryBreak", """
            func F() int32 {
                outer: for {
                    for {
                        try {
                            break outer
                        } finally {
                        }
                    }
                }
            }
            """);
        yield return Case("LabeledCatchBreak", """
            import System
            func F() int32 {
                outer: for {
                    for {
                        try {
                            throw Exception("boom")
                        } catch (ex Exception) {
                            break outer
                        }
                    }
                }
            }
            """);
        yield return Case("LabeledFinallyBreak", """
            func F() int32 {
                outer: for {
                    for {
                        try {
                            return 1
                        } finally {
                            break outer
                        }
                    }
                }
            }
            """);
        yield return Case("TryGoto", """
            func F() int32 {
                try {
                    goto done
                } finally {
                }
                return 1
            done:
                var reached = true
            }
            """);
        yield return Case("GotoIntoTryThenBreak", """
            func F(returnFromTry bool) int32 {
                for {
                    goto inside
                    try {
                    inside:
                        if returnFromTry {
                            return 1
                        }
                        break
                    } finally {
                    }
                }
            }
            """);
        yield return Case("CatchGoto", """
            import System
            func F() int32 {
                try {
                    throw Exception("boom")
                } catch (ex Exception) {
                    goto done
                }
                return 1
            done:
                var reached = true
            }
            """);
        yield return Case("FinallyGoto", """
            func F() int32 {
                try {
                    return 1
                } finally {
                    goto done
                }
            done:
                var reached = true
            }
            """);
        yield return Case("ExceptionSuppressedByFinallyGotoMissingReturn", """
            import System
            func F() int32 {
                try {
                    throw Exception("origin")
                } finally {
                    goto done
                }
            done:
                var reached = true
            }
            """);
        yield return Case("ImplicitExceptionSuppressedByFinallyGoto", """
            import System
            func Crash() {
                throw Exception("origin")
            }
            func F() int32 {
                try {
                    for {
                        Crash()
                    }
                } finally {
                    goto done
                }
            done:
                var reached = true
            }
            """);
        yield return Case("NestedTryBreak", """
            func F() int32 {
                for {
                    try {
                        try {
                            break
                        } finally {
                        }
                    } finally {
                    }
                }
            }
            """);
        yield return Case("TryInsideCatchBreak", """
            import System
            func F() int32 {
                for {
                    try {
                        throw Exception("outer")
                    } catch (ex Exception) {
                        try {
                            break
                        } finally {
                        }
                    }
                }
            }
            """);
        yield return Case("TryInsideFinallyBreak", """
            func F() int32 {
                for {
                    try {
                        return 1
                    } finally {
                        try {
                            break
                        } finally {
                        }
                    }
                }
            }
            """);
        yield return Case("TryInsideSwitchArmBreak", """
            func F(x int32) int32 {
                outer: for {
                    switch x {
                        default {
                            try {
                                break outer
                            } finally {
                            }
                        }
                    }
                }
            }
            """);
        yield return Case("SwitchInsideTryBreak", """
            func F(x int32) int32 {
                outer: for {
                    try {
                        switch x {
                            default { break outer }
                        }
                    } finally {
                    }
                }
            }
            """);
        yield return Case("TryInsideSelectBreak", """
            func F() int32 {
                outer: for {
                    select {
                        default {
                            try {
                                break outer
                            } finally {
                            }
                        }
                    }
                }
            }
            """);
        yield return Case("SelectInsideTryBreak", """
            func F() int32 {
                outer: for {
                    try {
                        select {
                            default { break outer }
                        }
                    } finally {
                    }
                }
            }
            """);
        yield return Case("TryInsideFixedBreak", """
            func F(xs []int32) int32 {
                unsafe {
                    for {
                        fixed p *int32 = xs {
                            try {
                                break
                            } finally {
                            }
                        }
                    }
                }
            }
            """);
        yield return Case("TryInsideScopeBreak", """
            func F() int32 {
                for {
                    scope {
                        try {
                            break
                        } finally {
                        }
                    }
                }
            }
            """);
        yield return Case("TryInsideUsingBreak", """
            import System.IO
            func F() int32 {
                for {
                    using let stream = MemoryStream()
                    try {
                        break
                    } finally {
                    }
                }
            }
            """);
        yield return Case("MixedCatchEscape", """
            import System
            func F(flag bool) int32 {
                for {
                    try {
                        if flag {
                            return 1
                        }
                        throw Exception("boom")
                    } catch (ex Exception) {
                        break
                    } finally {
                    }
                }
            }
            """);
        yield return Case("NormalTryCompletion", """
            func F() int32 {
                try {
                    var value = 1
                } finally {
                }
            }
            """);
        yield return Case("ExistingLoopBreak", """
            func F() int32 {
                for {
                    break
                }
            }
            """);
    }

    /// <summary>Gets try-region shapes that must not report GS0100.</summary>
    public static IEnumerable<object[]> CompleteCases()
    {
        yield return Case("FinallyLoopAfterWhileTrue", """
            import System
            func F(exit bool) int32 {
                try {
                    while true {
                        if exit {
                            return 1
                        }
                    }
                } finally {
                    for var i = 0; i < 1; i++ {
                        try {
                            var cleaned = i
                        } catch (ex Exception) {
                        }
                    }
                }
            }
            """);
        yield return Case("WhileTrueInsideTryFinally", """
            import System
            func F(exit bool) int32 {
                try {
                    try {
                        var initialized = true
                    } catch (ex Exception) {
                    }
                    while true {
                        if exit {
                            return 1
                        }
                        if !exit {
                            continue
                        }
                    }
                } finally {
                    for var i = 0; i < 1; i++ {
                        try {
                            var cleaned = i
                        } catch (ex Exception) {
                        }
                    }
                }
            }
            """);
        yield return Case("TryContinue", """
            func F() int32 {
                for {
                    try {
                        continue
                    } finally {
                    }
                    break
                }
            }
            """);
        yield return Case("LabeledTryContinue", """
            func F() int32 {
                outer: for {
                    for {
                        try {
                            continue outer
                        } finally {
                        }
                        break outer
                    }
                }
            }
            """);
        yield return Case("CatchContinue", """
            import System
            func F() int32 {
                for {
                    try {
                        throw Exception("boom")
                    } catch (ex Exception) {
                        continue
                    }
                    break
                }
            }
            """);
        yield return Case("FinallyContinue", """
            func F() int32 {
                for {
                    try {
                        var value = 1
                    } finally {
                        continue
                    }
                    break
                }
            }
            """);
        yield return Case("LabeledCatchContinue", """
            import System
            func F() int32 {
                outer: for {
                    for {
                        try {
                            throw Exception("boom")
                        } catch (ex Exception) {
                            continue outer
                        }
                        break outer
                    }
                }
            }
            """);
        yield return Case("LabeledFinallyContinue", """
            func F() int32 {
                outer: for {
                    for {
                        try {
                            var value = 1
                        } finally {
                            continue outer
                        }
                        break outer
                    }
                }
            }
            """);
        yield return Case("TryFinallyReturn", """
            func F() int32 {
                try {
                    return 1
                } finally {
                }
            }
            """);
        yield return Case("FinallyReturn", """
            func F() int32 {
                try {
                    return 1
                } finally {
                    return 2
                }
            }
            """);
        yield return Case("ConditionalFinallyReturnOverException", """
            import System
            func F(replace bool) int32 {
                try {
                    throw Exception("origin")
                } finally {
                    if replace {
                        return 2
                    }
                }
            }
            """);
        yield return Case("ConditionalFinallyReturnOverReturn", """
            func F(replace bool) int32 {
                try {
                    return 1
                } finally {
                    if replace {
                        return 2
                    }
                }
            }
            """);
        yield return Case("ConditionalFinallyReturnOverBreak", """
            func F(replace bool) int32 {
                var count = 0
                for i in 0 ... 3 {
                    try {
                        break
                    } finally {
                        if replace {
                            return 2
                        }
                    }
                    count += 1
                }
                return count
            }
            """);
        yield return Case("RethrowPreservesOriginStack", """
            import System
            func Origin() {
                throw Exception("origin")
            }
            func F(replace bool) int32 {
                try {
                    Origin()
                    return 0
                } finally {
                    if replace {
                        return 2
                    }
                }
            }
            """);
        yield return Case("ExceptionSuppressedByFinallyBreak", """
            import System
            func F() int32 {
                for {
                    try {
                        throw Exception("origin")
                    } finally {
                        break
                    }
                }
                return 4
            }
            """);
        yield return Case("ExceptionSuppressedByFinallyContinue", """
            import System
            func F() int32 {
                for i in 0 ... 3 {
                    try {
                        throw Exception("origin")
                    } finally {
                        continue
                    }
                }
                return 3
            }
            """);
        yield return Case("ExceptionSuppressedByFinallyGoto", """
            import System
            func F() int32 {
                try {
                    throw Exception("origin")
                } finally {
                    goto done
                }
            done:
                return 5
            }
            """);
        yield return Case("TryCatchReturns", """
            import System
            func F(flag bool) int32 {
                try {
                    if flag {
                        return 1
                    }
                    throw Exception("boom")
                } catch (ex Exception) {
                    return 2
                }
            }
            """);
        yield return Case("TryCatchFinallyReturns", """
            import System
            func F(flag bool) int32 {
                try {
                    if flag {
                        return 1
                    }
                    throw Exception("boom")
                } catch (ex Exception) {
                    return 2
                } finally {
                }
            }
            """);
        yield return Case("ConditionalFinallyReturnOverCatchReturn", """
            import System
            func F(replace bool) int32 {
                try {
                    throw Exception("origin")
                } catch (ex Exception) {
                    return 1
                } finally {
                    if replace {
                        return 2
                    }
                }
            }
            """);
        yield return Case("CatchRethrows", """
            import System
            func F(flag bool) int32 {
                try {
                    if flag {
                        return 1
                    }
                    throw Exception("first")
                } catch (ex Exception) {
                    throw Exception("second")
                }
            }
            """);
        yield return Case("FinallyThrows", """
            import System
            func F() int32 {
                try {
                    var value = 1
                } finally {
                    throw Exception("stop")
                }
            }
            """);
        yield return Case("FinallyInfiniteLoop", """
            func F() int32 {
                try {
                    var value = 1
                } finally {
                    for {
                    }
                }
            }
            """);
        yield return Case("BreakSuppressedByInfiniteFinally", """
            func F() int32 {
                for {
                    try {
                        break
                    } finally {
                        for {
                        }
                    }
                }
            }
            """);
        yield return Case("ReturnAfterTryBreak", """
            func F() int32 {
                for {
                    try {
                        break
                    } finally {
                    }
                }
                return 7
            }
            """);
        yield return Case("ReturnAfterCatchBreak", """
            import System
            func F() int32 {
                for {
                    try {
                        throw Exception("boom")
                    } catch (ex Exception) {
                        break
                    }
                }
                return 8
            }
            """);
        yield return Case("TryGotoThenReturn", """
            func F() int32 {
                try {
                    goto done
                } finally {
                }
                return 1
            done:
                return 2
            }
            """);
        yield return Case("CatchGotoThenReturn", """
            import System
            func F() int32 {
                try {
                    throw Exception("boom")
                } catch (ex Exception) {
                    goto done
                }
                return 1
            done:
                return 2
            }
            """);
        yield return Case("FinallyGotoThenReturn", """
            func F() int32 {
                try {
                    return 1
                } finally {
                    goto done
                }
            done:
                return 2
            }
            """);
        yield return Case("TryInsideFinallyReturns", """
            func F() int32 {
                try {
                    return 1
                } finally {
                    try {
                        var value = 2
                    } finally {
                    }
                }
            }
            """);
        yield return Case("NestedFinallyBreakThenReturn", """
            func F() int32 {
                for {
                    try {
                        return 1
                    } finally {
                        try {
                            break
                        } finally {
                        }
                    }
                }
                return 6
            }
            """);
        yield return Case("SwitchInsideTryBreakOverriddenByReturn", """
            func F() int32 {
                for {
                    try {
                        switch 0 {
                            default { break }
                        }
                    } finally {
                        return 1
                    }
                }
            }
            """);
        yield return Case("SelectInsideTryBreakOverriddenByReturn", """
            func F() int32 {
                for {
                    try {
                        select {
                            default { break }
                        }
                    } finally {
                        return 2
                    }
                }
            }
            """);
        yield return Case("ScopeInsideTryBreakOverriddenByReturn", """
            func F() int32 {
                for {
                    try {
                        scope {
                            break
                        }
                    } finally {
                        return 4
                    }
                }
            }
            """);
    }

    [Theory]
    [MemberData(nameof(MissingReturnCases))]
    public void EscapingOrCompletingPath_ReportsGs0100(string name, string source)
    {
        _ = name;
        var (diagnostics, emittedLength) = Compile(source);
        var diagnostic = Assert.Single(diagnostics.Where(candidate => candidate.IsError));
        Assert.Equal("GS0100", diagnostic.Id);
        Assert.Equal("F", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.Equal(0, emittedLength);
    }

    [Theory]
    [MemberData(nameof(CompleteCases))]
    public void EveryPathTerminates_DoesNotReportGs0100(string name, string source)
    {
        _ = name;
        var (diagnostics, emittedLength) = Compile(source);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
        Assert.True(emittedLength > 0);
    }

    private static object[] Case(string name, string body)
        => new object[] { name, $"package Issue2891.{name}{Environment.NewLine}{body}" };

    private static (System.Collections.Immutable.ImmutableArray<Diagnostic> Diagnostics, long EmittedLength) Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return (compilation.Emit(peStream).Diagnostics, peStream.Length);
    }
}
