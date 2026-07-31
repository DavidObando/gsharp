// <copyright file="Issue2885NullableDelegateReceiverInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2885 interpreter parity for guarded nullable function calls.
/// </summary>
public class Issue2885NullableDelegateReceiverInterpreterTests
{
    [Fact]
    public void GuardedNullableFunctionInvokesInWhile()
    {
        const string source = """
            var result = 0
            let write = (value int32) -> { result = value }
            var handler ((int32) -> void)? = write
            while handler != nil {
                handler(42)
                break
            }

            result
            """;

        AssertEvaluates(source, 42);
    }

    [Fact]
    public void GuardedNullableFunctionInvokesInForClause()
    {
        const string source = """
            var result = 0
            let write = (value int32) -> { result = value }
            var handler ((int32) -> void)? = write
            for var i = 0; handler != nil && i < 1; i++ {
                handler(43)
            }

            result
            """;

        AssertEvaluates(source, 43);
    }

    private static void AssertEvaluates(string source, int expected)
    {
        var evaluation = new Compilation(SyntaxTree.Parse(source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(evaluation.Diagnostics);
        Assert.Equal(expected, evaluation.Value);
    }
}
