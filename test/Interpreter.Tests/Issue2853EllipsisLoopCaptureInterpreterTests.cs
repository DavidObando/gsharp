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

    [Fact]
    public void CapturedIndexWritesUseExpressionTargets()
    {
        AssertEvaluates(
            """
            import System.Collections.Generic

            func mutate() int32 {
                var slice = []int32{1}
                var values = map[string,int32]{"x": 2}
                var list = List[int32]()
                list.Add(3)
                var read = () -> { return slice[0] + values["x"] + list[0] }

                slice[0] = 40
                values["x"] = 50
                list[0] = 60
                return slice[0] + values["x"] + list[0] + read()
            }

            mutate()
            """,
            expected: 300);
    }

    [Fact]
    public void CapturedInstanceFieldWritesUseExpressionReceivers()
    {
        AssertEvaluates(
            """
            class Counter {
                var Value int32
            }

            struct Pair {
                var Value int32
            }

            func mutate() int32 {
                var counter = Counter()
                counter.Value = 5
                var readCounter = () -> { return counter.Value }

                var pair = Pair{Value: 1}
                var readPair = () -> { return pair.Value }
                pair.Value = 6

                return counter.Value + readCounter() + pair.Value + readPair()
            }

            mutate()
            """,
            expected: 22);
    }

    [Fact]
    public void CapturedRefOutAndAliasWritesUseCallerCell()
    {
        AssertEvaluates(
            """
            func addOne(ref value int32) {
                value = value + 1
            }

            func setSeven(out value int32) {
                value = 7
            }

            func mutate() int32 {
                var n = 1
                var readN = () -> { return n }
                let ref alias = n
                alias = alias + 1
                addOne(ref n)

                var m = 0
                var readM = () -> { return m }
                setSeven(out m)

                return n * 1000 + readN() * 100 + m * 10 + readM()
            }

            mutate()
            """,
            expected: 3377);
    }

    [Fact]
    public void CapturedNilClassFieldWriteReportsDiagnostic()
    {
        const string Source = """
            class Counter {
                var Value int32
            }

            func mutate() int32 {
                var counter = Counter()
                var read = () -> { return counter.Value }
                counter = nil
                counter.Value = 5
                return read()
            }

            mutate()
            """;

        var result = new Compilation(SyntaxTree.Parse(Source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Contains(result.Diagnostics, d => d.Id == "GS9999");
    }

    private static void AssertEvaluates(string source, int expected)
    {
        var result = new Compilation(SyntaxTree.Parse(source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }
}
