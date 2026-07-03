// <copyright file="Issue1885LockStatementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1885: G# gains a first-class <c>lock target { body }</c> statement
/// with the same semantics as C#'s <c>lock</c> — <c>Monitor.Enter</c>, then
/// <c>try { body } finally { Monitor.Exit }</c>. Previously cs2gs lowered
/// C# <c>lock</c> to raw <c>Monitor.Enter</c>/<c>Monitor.Exit</c> calls
/// without ever emitting <c>import System.Threading</c>, so the translated
/// G# failed to compile (GS0157). These tests exercise the new <c>lock</c>
/// keyword directly at the gsc level (parse, bind, evaluate).
/// </summary>
public class Issue1885LockStatementTests
{
    [Fact]
    public void Lock_RunsBody_AndReturnsMutatedValue()
    {
        var source = @"
class Gate {}

var g = Gate{}
var total = 0
lock g {
    total = total + 1
    total = total + 1
}
total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void Lock_ReleasesOnException_ViaFinally()
    {
        // The body throws; a `finally`-released monitor lets a later `lock`
        // against the SAME target re-acquire it with no deadlock — the
        // deterministic proof that `lock` lowers through try/finally.
        var source = @"
import System

class Gate {}

var g = Gate{}
var trace = """"
try {
    lock g {
        trace = trace + ""a""
        throw Exception(""boom"")
    }
} catch (e Exception) {
    trace = trace + ""c""
}

lock g {
    trace = trace + ""b""
}

trace
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("acb", result.Value);
    }

    [Fact]
    public void Lock_EvaluatesTargetExactlyOnce()
    {
        // A non-trivial (side-effecting) lock target must be evaluated
        // exactly once — not once for Enter and again for Exit.
        var source = @"
class Gate {}

func GetGate() Gate {
    callCount = callCount + 1
    return Gate{}
}

var callCount = 0
lock GetGate() {
    var x = 1
}
callCount
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void Lock_OnValueTypeTarget_IsDiagnosed()
    {
        var diagnostics = Bind(@"
var n = 1
lock n {
    var x = 1
}
");
        Assert.NotEmpty(diagnostics);
        Assert.Contains(diagnostics, d => d.Message.Contains("reference type"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
        => Evaluate(source).Diagnostics;
}
