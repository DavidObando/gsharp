// <copyright file="Issue1922TupleForInStatementTests.cs" company="GSharp">
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
/// Issue #1922: cs2gs lowered a C# <c>foreach (var (a, b) in list)</c> over a
/// <c>List&lt;(T1, T2)&gt;</c> to <c>for tmp in list { let (a, b) = tmp ... }</c>,
/// which failed <c>GS0164</c> because the loop element's static type — a
/// CLR <c>System.ValueTuple&lt;...&gt;</c> reached via reflection (the
/// element type of an imported generic collection), not a G# tuple-literal
/// parse — surfaced as a plain <see cref="ImportedTypeSymbol"/> rather than
/// <see cref="TupleTypeSymbol"/>. Covers both halves of the fix: (1)
/// <c>let (a, b) = expr</c> deconstruction now accepts that CLR-shaped
/// tuple, and (2) G#'s new first-class <c>for (a, b) in coll</c> loop header.
/// </summary>
public class Issue1922TupleForInStatementTests
{
    [Fact]
    public void LetDeconstruction_AcceptsValueTupleElementFromClrListIteration()
    {
        // Reproduces the exact shape cs2gs used to hand-emit: a hidden
        // single-var loop over `List[(string, int32)]` whose element type is
        // resolved through the CLR-generic-argument path (not a G# tuple
        // literal), then deconstructed via `let`.
        var source = @"
import System.Collections.Generic

var list = List[(string, int32)]()
list.Add((""alice"", 1))
list.Add((""bob"", 2))

var total = 0
for tmp in list {
    let (name, score) = tmp
    total = total + score
}
total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1 + 2, result.Value);
    }

    [Fact]
    public void ForTupleIn_DeconstructsListOfValueTuples()
    {
        var source = @"
import System.Collections.Generic

var list = List[(string, int32)]()
list.Add((""alice"", 1))
list.Add((""bob"", 2))

var total = 0
for (name, score) in list {
    total = total + score
}
total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1 + 2, result.Value);
    }

    [Fact]
    public void ForTupleIn_DeconstructsArrayOfTupleLiterals()
    {
        // Also exercise the indexed (array) iteration strategy, not just the
        // CLR-enumerable one, since `BindForTupleRangeStatementCore` reuses
        // the shared `BindForRangeStatementCore` dispatch for both.
        var source = @"
var pairs = [2](int32, int32){(1, 2), (3, 4)}

var total = 0
for (a, b) in pairs {
    total = total + a + b
}
total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1 + 2 + 3 + 4, result.Value);
    }

    [Fact]
    public void ForTupleIn_ArityMismatch_ReportsGS0163()
    {
        var source = @"
var pairs = [2](int32, int32){(1, 2), (3, 4)}

for (a, b, c) in pairs {
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0163");
    }

    [Fact]
    public void ForTupleIn_NonTupleElement_ReportsGS0164()
    {
        var source = @"
var xs = [3]int32{1, 2, 3}

for (a, b) in xs {
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0164");
    }

    [Fact]
    public void ForTupleIn_Labeled_BreakByLabelExitsLoop()
    {
        var source = @"
var pairs = [3](int32, int32){(1, 2), (3, 4), (5, 6)}

var seen = 0
outer: for (a, b) in pairs {
    if a == 3 {
        break outer
    }

    seen = seen + 1
}
seen
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void ForTupleIn_ParsesAsForTupleRangeStatement()
    {
        const string source = @"
package p
class C { func F(xs [](int32, int32)) { for (a, b) in xs { } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
