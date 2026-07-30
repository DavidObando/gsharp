// <copyright file="Issue2853EllipsisLoopCaptureInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2853 interpreter guard for numeric ellipsis loop capture semantics.
/// </summary>
public class Issue2853EllipsisLoopCaptureInterpreterTests
{
    [Fact]
    public void ClosureCapturesValueFromCreatingIteration()
    {
        AssertEvaluates(
            """
            func capture() int32 {
                var callback = () -> { return -1 }

                for i in 0 ... 3 {
                    if i == 0 { callback = () -> { return i } }
                }

                return callback()
            }

            capture()
            """,
            expected: 0);
    }

    [Fact]
    public void CapturedWriteAdvancesLoopControlVariable()
    {
        AssertEvaluates(
            """
            func countIterations() int32 {
                var iterations = 0
                for i in 0 ... 5 {
                    var bump = () -> { i = i + 1 }
                    bump()
                    iterations = iterations + 1
                }

                return iterations
            }

            countIterations()
            """,
            expected: 3);
    }

    [Fact]
    public void CapturedFunctionLocalWritesSharedCell()
    {
        AssertEvaluates(
            """
            func mutate() int32 {
                var value = 20
                var bump = () -> { value = value + 1 }
                bump()
                return value
            }

            mutate()
            """,
            expected: 21);
    }

    private static void AssertEvaluates(string source, int expected)
    {
        var result = new Compilation(SyntaxTree.Parse(source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }
}
