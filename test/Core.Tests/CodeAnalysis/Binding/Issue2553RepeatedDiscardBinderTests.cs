// <copyright file="Issue2553RepeatedDiscardBinderTests.cs" company="GSharp">
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

public class Issue2553RepeatedDiscardBinderTests
{
    [Fact]
    public void RepeatedDiscards_BindInTupleLetAssignmentAndLoop()
    {
        const string source = """
            var value = 0
            let (kept, _, _) = (1, 2, 3)
            value, _, _ = 4, 5, 6
            for (item, _, _) in [1](int32, int32, int32){(7, 8, 9)} {
                value = value + item
            }
            """;

        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Theory]
    [InlineData("let (name, name, _) = (1, 2, 3)")]
    [InlineData("for (name, name, _) in [1](int32, int32, int32){(1, 2, 3)} { }")]
    public void RepeatedRealNames_StillReportGS0102(string statement)
    {
        var result = Evaluate(statement);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0102");
    }

    [Fact]
    public void TupleDiscard_DoesNotEnterLookupScope()
    {
        var result = Evaluate("let (value, _, _) = (1, 2, 3)\n_");

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0125");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree).Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
