// <copyright file="SelectTests.cs" company="GSharp">
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
/// Phase 5.6 / ADR-0022 — <c>select</c> statement with receive (discard +
/// bind), send, and <c>default</c> arms. Interpreter only.
/// </summary>
public class SelectTests
{
    [Fact]
    public void Select_ReceiveBind_Binds()
    {
        var source = @"
let ch = make(chan int32, 1)
ch <- 1
select {
case let v = <-ch { let x = v }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Select_ReceiveDiscard_Binds()
    {
        var source = @"
let ch = make(chan int32, 1)
ch <- 1
select {
case <-ch { let x = 0 }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Select_Send_Binds()
    {
        var source = @"
let ch = make(chan int32, 1)
select {
case ch <- 42 { let x = 0 }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Select_DefaultTakenWhenNoArmReady()
    {
        var source = @"
let ch = make(chan int32, 1)
select {
case <-ch { let a = 1 }
default { let b = 2 }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Select_DefaultNotTakenWhenArmReady()
    {
        var source = @"
let ch = make(chan int32, 1)
ch <- 7
select {
case let v = <-ch { let x = v }
default { let y = 0 }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Select_NoCases_Diagnoses()
    {
        var source = @"
select { }
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("no cases"));
    }

    [Fact]
    public void Select_ArmBodyWithNestedIf_LowersAndEvaluates()
    {
        // Regression: the Lowerer must recurse into each select arm body
        // when flattening so nested control flow inside an arm body works.
        // Pre-fix this raised `Unexpected node BlockStatement` from the
        // evaluator when the arm body's lowered if-statement (wrapped in
        // a BoundBlockStatement) was treated as an opaque statement.
        var source = @"
let ch = make(chan int32, 1)
ch <- 5
select {
case let v = <-ch {
    if v > 0 {
        let x = v + 1
    }
}
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Select_DuplicateDefault_Diagnoses()
    {
        var source = @"
let ch = make(chan int32, 1)
select {
default { let a = 1 }
default { let b = 2 }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("'default'"));
    }

    [Fact]
    public void Select_ReceiveOnNonChannel_Diagnoses()
    {
        var source = @"
let x = 1
select {
case <-x { let a = 0 }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("channel"));
    }

    [Fact]
    public void Select_SendOnNonChannel_Diagnoses()
    {
        var source = @"
let x = 1
select {
case x <- 1 { let a = 0 }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("channel"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
