// <copyright file="Issue2943LoopBackEdgeNarrowingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Interpreter coverage for issue #2943 loop back-edge narrowing.
/// </summary>
public class Issue2943LoopBackEdgeNarrowingInterpreterTests
{
    [Theory]
    [InlineData("function")]
    [InlineData("top-level")]
    public void AssignmentAfterUse_ReportsNullableReceiver(string scope)
    {
        const string Declarations = """
            class C {
                func Print() { }
            }
            """;
        const string Body = """
            var c C? = C()
            if c != nil {
                for var i = 0; i < 2; i++ {
                    c.Print()
                    c = nil
                }
            }
            """;
        var source = scope == "top-level"
            ? Declarations + Environment.NewLine + Body
            : Declarations + Environment.NewLine + $$"""

            func run() {
            {{Indent(Body)}}
            }

            run()
            """;

        var result = new Compilation(SyntaxTree.Parse(source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0159");
    }

    [Theory]
    [InlineData("constructor", "c = C(33)", "function")]
    [InlineData("local", "c = fresh", "function")]
    [InlineData("function", "c = Mk(33)", "function")]
    [InlineData("constructor", "c = C(33)", "top-level")]
    [InlineData("local", "c = fresh", "top-level")]
    [InlineData("function", "c = Mk(33)", "top-level")]
    public void NonNullAssignmentAfterUse_PreservesInheritedNarrowing(
        string shape,
        string secondIterationAssignment,
        string scope)
    {
        const string Declarations = """
            class C {
                let Value int32

                init(value int32) {
                    Value = value
                }
            }

            func Mk(value int32) C {
                return C(value)
            }
            """;
        var body = $$"""
            var c C? = C(11)
            let fresh C = C(33)
            var sum = 0
            if c != nil {
                for var i = 0; i < 3; i++ {
                    sum = sum + c.Value
                    if i == 0 {
                        c = C(22)
                    }
                    if i == 1 {
                        {{secondIterationAssignment}}
                    }
                }
            }
            """;
        var source = scope == "top-level"
            ? Declarations + Environment.NewLine + body + Environment.NewLine + "sum"
            : Declarations + Environment.NewLine + $$"""
                func run() int32 {
                {{Indent(body)}}
                    return sum
                }

                run()
                """;

        var result = new Compilation(SyntaxTree.Parse(source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.True(
            result.Diagnostics.IsEmpty,
            $"{shape}/{scope}: {string.Join(Environment.NewLine, result.Diagnostics)}");
        Assert.Equal(66, result.Value);
    }

    [Fact]
    public void LoopConditionReestablishesNarrowing()
    {
        const string Source = """
            class C {
                func M() { }
            }

            func run() int32 {
                var c C? = C()
                var count = 0
                while c != nil {
                    c.M()
                    count++
                    c = nil
                }
                return count
            }

            run()
            """;

        var result = new Compilation(SyntaxTree.Parse(Source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private static string Indent(string source)
        => "    " + source.Replace(Environment.NewLine, Environment.NewLine + "    ", StringComparison.Ordinal);
}
