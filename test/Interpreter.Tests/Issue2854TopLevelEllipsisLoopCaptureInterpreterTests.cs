// <copyright file="Issue2854TopLevelEllipsisLoopCaptureInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2854 interpreter guard for top-level numeric ellipsis loop captures.
/// </summary>
public class Issue2854TopLevelEllipsisLoopCaptureInterpreterTests
{
    [Fact]
    public void TopLevelClosureCapturesIterationVariable()
    {
        AssertEvaluates(
            """
            var callback = () -> { return -1 }

            for i in 0 ... 1 {
                callback = () -> { return i }
            }

            let result = callback()
            result
            """,
            expected: 0);
    }

    [Fact]
    public void TopLevelForInCapturedWriteUsesSharedCell()
    {
        AssertEvaluates(
            """
            var source = []int32{7, 8}
            var total = 0
            for value in source {
                var bump = () -> { value = value + 100 }
                bump()
                total = total + value
            }

            total
            """,
            expected: 215);
    }

    private static void AssertEvaluates(string source, int expected)
    {
        var result = EmittedOracle.Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }
}
