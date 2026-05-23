// <copyright file="AsyncAwaitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 5.1 + 5.2 — <c>async func</c> declarations and <c>await</c> expressions.
/// </summary>
public class AsyncAwaitTests
{
    [Fact]
    public void AsyncFunction_DeclaresAndBinds()
    {
        var source = @"
async func answer() int {
    return 42
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Await_AsyncUserFunction_UnwrapsResultType()
    {
        var source = @"
async func answer() int {
    return 42
}

async func main() int {
    let v = await answer()
    return v
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Await_OutsideAsync_Diagnoses()
    {
        var source = @"
async func answer() int {
    return 42
}

func main() int {
    let v = await answer()
    return v
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("'await'"));
    }

    [Fact]
    public void Await_NonTask_Diagnoses()
    {
        var source = @"
async func main() int {
    let v = await 42
    return v
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("cannot be awaited"));
    }

    [Fact]
    public void AsyncCall_AtTopLevel_ProducesTask()
    {
        // The call expression in an expression-statement is allowed even though
        // we cannot await it here. We just verify it binds cleanly.
        var source = @"
async func tick() int {
    return 1
}

tick()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
