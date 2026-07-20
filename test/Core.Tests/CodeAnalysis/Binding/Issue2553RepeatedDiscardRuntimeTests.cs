// <copyright file="Issue2553RepeatedDiscardRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public class Issue2553RepeatedDiscardRuntimeTests
{
    [Fact]
    public void RepeatedDiscards_PreserveValuesAndEvaluateAssignmentRightHandSides()
    {
        const string source = """
            var calls = 0
            let (kept, _, _) = (10, 20, 30)
            var assigned = 0
            assigned, _, _ = ++calls, ++calls, ++calls
            var loopTotal = 0
            for (first, _, _) in [2](int32, int32, int32){(2, 20, 200), (3, 30, 300)} {
                loopTotal = loopTotal + first
            }
            kept + assigned + calls + loopTotal
            """;

        var result = Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(19, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree).Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
