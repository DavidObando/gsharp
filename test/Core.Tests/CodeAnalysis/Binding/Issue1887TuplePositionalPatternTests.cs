// <copyright file="Issue1887TuplePositionalPatternTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1887: a C# positional pattern over a raw tuple lowers to a G#
/// property pattern keyed on the tuple's Item1..ItemN fields. Previously the
/// property-pattern matcher rejected a ValueTuple subject (GS0172); it now
/// binds, emits, and evaluates against tuple element fields.
/// </summary>
public class Issue1887TuplePositionalPatternTests
{
    [Fact]
    public void SwitchExpression_TuplePropertyPattern_MatchesFirstArm()
    {
        AssertEvaluates(@"
let p = (0, 0)
let x = switch p { case { Item1: 0, Item2: 0 }: ""origin"" default: ""other"" }
x
", "origin");
    }

    [Fact]
    public void SwitchExpression_TuplePropertyPattern_FallsThroughToDefault()
    {
        AssertEvaluates(@"
let p = (3, 4)
let x = switch p { case { Item1: 0, Item2: 0 }: ""origin"" default: ""other"" }
x
", "other");
    }

    [Fact]
    public void SwitchExpression_TuplePropertyPattern_RelationalSubpattern()
    {
        AssertEvaluates(@"
let p = (3, 4)
let x = switch p { case { Item1: 0, Item2: 0 }: ""origin"" case { Item1: > 0, Item2: > 0 }: ""ne"" default: ""other"" }
x
", "ne");
    }

    [Fact]
    public void SwitchExpression_TuplePropertyPattern_DiscardSubpattern()
    {
        AssertEvaluates(@"
let p = (0, 7)
let x = switch p { case { Item1: 0, Item2: 0 }: ""origin"" case { Item1: 0, Item2: _ }: ""y-axis"" default: ""other"" }
x
", "y-axis");
    }

    [Fact]
    public void SwitchExpression_TuplePropertyPattern_ArityThree()
    {
        AssertEvaluates(@"
let p = (0, 0, 5)
let x = switch p { case { Item1: 0, Item2: 0, Item3: 5 }: ""hit"" default: ""miss"" }
x
", "hit");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static void AssertEvaluates(string source, object expected)
    {
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }
}
