// <copyright file="GoStatementTests.cs" company="GSharp">
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

/// <summary>
/// Phase 5.3 — <c>go f(args)</c> statement (interpreter).
/// </summary>
public class GoStatementTests
{
    [Fact]
    public void Go_OnUserFunctionCall_Binds()
    {
        var source = @"
func work() int {
    return 1
}

go work()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Go_OnAsyncFunctionCall_Binds()
    {
        var source = @"
async func work() int {
    return 1
}

go work()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Go_OnNonCallExpression_Diagnoses()
    {
        var source = @"
let x = 42
go x
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("'go'"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
