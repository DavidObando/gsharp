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
using GSharp.Tests;
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
func work() int32 { return 1 }

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
let ch = chan[int32](1)

func send() int32 {
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
        // GS0286 (TLS must be contiguous, ADR-0066 D5) fires as a warning
        // on this helper-between-TLS layout; the test exercises channel
        // semantics, not the layout warning, so filter it.
        Assert.DoesNotContain(result.Diagnostics, d => d.Id != "GS0286");
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void Scope_NestedScopes_Bind()
    {
        var source = @"
func work() int32 { return 1 }

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
    public void Scope_BodyWithNestedIf_LowersAndEvaluates()
    {
        // Regression: the Lowerer must recurse into the scope body when
        // flattening so emitted execution receives a flat statement list
        // (gotos for `if`) rather than a residual BoundIfStatement / nested
        // BoundBlockStatement.
        var source = @"
let n = 3
scope {
    if n > 0 {
        let x = n + 1
    } else {
        let y = n - 1
    }
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

func boom() int32 {
    let n = Int32.Parse(""bad"")
    return n
}

scope {
    go boom()
}
";
        // The scoped goroutine binds without any import (ADR-0174 removed the
        // gate), so the failure surfaces from the runtime, which is what this
        // test actually exercises.
        var result = EmittedOracle.Evaluate(source);

        // The failure may surface either as an unhandled runtime exception
        // or as a reported diagnostic — both are acceptable, what matters
        // is that the failure was not silently swallowed.
        Assert.True(
            result.UnhandledException != null || !result.Diagnostics.IsEmpty,
            "Scope did not surface the failure from the scoped goroutine.");
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        // ADR-0082 / issue #722: prepend the Go-extensions import so
        // existing scope-with-go tests continue to exercise scope
        // semantics rather than the import gate.
        var fullSource = source;
        return EmittedOracle.Evaluate(fullSource);
    }
}
