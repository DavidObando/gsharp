// <copyright file="Issue1278ArrowExpressionMemberTests.cs" company="GSharp">
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
/// Issue #1278 / ADR-0131: binder/interpreter coverage for expression-bodied
/// members using the G# arrow <c>-&gt;</c>. The arrow forms desugar to the same
/// block bodies they would otherwise spell, so they bind, type-check, and
/// evaluate identically to their block-bodied equivalents.
/// </summary>
public class Issue1278ArrowExpressionMemberTests
{
    [Fact]
    public void FunctionArrowBody_BindsAndEvaluates()
    {
        var source = @"
func square(x int32) int32 -> x * x

var r = square(7)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(49, result.Value);
    }

    [Fact]
    public void ReadOnlyPropertyArrow_BindsAndEvaluates()
    {
        var source = @"
class Box {
    var seed int32
    prop Doubled int32 -> this.seed * 2
}

var b = Box()
b.seed = 21
var r = b.Doubled
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void AccessorArrows_RoundTripThroughField()
    {
        var source = @"
class Box {
    var n int32
    prop Value int32 {
        get -> this.n
        set -> this.n = value
    }
}

var b = Box()
b.Value = 17
var r = b.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(17, result.Value);
    }

    [Fact]
    public void ConversionOperatorArrow_BindsAndEvaluates()
    {
        var source = @"
struct Celsius {
    var degrees int32
}

func operator implicit (c Celsius) int32 -> c.degrees

var c = Celsius{degrees: 36}
var d int32 = c
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(36, result.Value);
    }

    [Fact]
    public void TypeErrorInArrowBody_IsReported()
    {
        // The desugared body type-checks exactly like a block body: a string
        // expression cannot satisfy an int32 return type.
        var source = @"
func bad(x int32) int32 -> ""nope""

var r = bad(1)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
