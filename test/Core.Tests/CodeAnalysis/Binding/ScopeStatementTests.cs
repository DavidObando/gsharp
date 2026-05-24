// <copyright file="ScopeStatementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 5.7 / ADR-0022 — <c>scope { … }</c> structured concurrency.
/// Spawned <c>go</c> tasks lexically inside the body are awaited at
/// scope exit; the first failure is propagated (additional failures
/// attach as <see cref="AggregateException"/> inner exceptions).
/// </summary>
public class ScopeStatementTests
{
    [Fact]
    public void Scope_Empty_Binds()
    {
        var result = Evaluate("scope { }\n");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Scope_WithGoStatements_Binds()
    {
        var source = @"
func work() int { return 1 }

scope {
    go work()
    go work()
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Scope_WithSendInsideGo_Binds()
    {
        var source = @"
let ch = make(chan int, 1)

func send() int {
    ch <- 7
    return 0
}

scope {
    go send()
}
let v = <-ch
v
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void Scope_NestedScopes_Bind()
    {
        var source = @"
func work() int { return 1 }

scope {
    scope {
        go work()
    }
    go work()
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Scope_FailureInGoTask_Propagates()
    {
        // A scoped goroutine that throws should cause the enclosing
        // scope to surface the failure at exit, not silently swallow
        // it (which is the behaviour of free-standing `go`).
        var source = @"
import System

func boom() int {
    let n = Int32.Parse(""bad"")
    return n
}

scope {
    go boom()
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        EvaluationResult result = null;
        Exception thrown = null;
        try
        {
            result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        }
        catch (Exception ex)
        {
            thrown = ex;
        }

        // The failure may surface either as a raw exception escaping
        // the evaluator or as an evaluator-reported diagnostic — both
        // are acceptable, what matters is that the failure was not
        // silently swallowed.
        Assert.True(
            thrown != null || (result != null && !result.Diagnostics.IsEmpty),
            "Scope did not surface the failure from the scoped goroutine.");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
