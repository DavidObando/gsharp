// <copyright file="Issue2769PositionalDeconstructionTests.cs" company="GSharp">
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

public sealed class Issue2769PositionalDeconstructionTests
{
    [Fact]
    public void PositionalDataClass_WrongArity_ReportsPositionalPropertyCount()
    {
        var result = Evaluate("""
            data class Pair(A int32, B int32) {
                prop Ignored int32 { get; init; }
            }
            let (only) = Pair(1, 2)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0163");
        Assert.Contains("requires 2 fields but was given 1", diagnostic.Message);
    }

    [Fact]
    public void OrdinaryClassProperties_DoNotEnableRecordDeconstruction()
    {
        var result = Evaluate("""
            class Pair {
                prop A int32 { get; init; }
                prop B int32 { get; init; }
            }
            let (a, b) = Pair()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0164");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
