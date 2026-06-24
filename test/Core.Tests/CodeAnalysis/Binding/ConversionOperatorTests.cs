// <copyright file="ConversionOperatorTests.cs" company="GSharp">
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
/// Issue #1017 — user-defined implicit/explicit conversion operators declared in
/// G# via <c>func operator implicit/explicit (x T) U</c>. They bind as static
/// <c>op_Implicit</c>/<c>op_Explicit</c> special-name methods and participate in
/// conversion resolution.
/// </summary>
public class ConversionOperatorTests
{
    [Fact]
    public void ImplicitConversion_AppliedAtAssignment_BindsAndEvaluates()
    {
        var source = @"
struct Celsius {
    var degrees int32
}

func operator implicit (c Celsius) int32 {
    return c.degrees
}

var c = Celsius{degrees: 42}
var d int32 = c
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ExplicitConversion_AppliedAtCast_BindsAndEvaluates()
    {
        var source = @"
struct Celsius {
    var degrees int32
}

func operator explicit (d int32) Celsius {
    return Celsius{degrees: d}
}

var raw = 7
var c = Celsius(raw)
var back = c.degrees
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ImplicitConversion_AppliedAtArgument_BindsAndEvaluates()
    {
        var source = @"
struct Celsius {
    var degrees int32
}

func operator implicit (c Celsius) int32 {
    return c.degrees
}

func doubleIt(n int32) int32 {
    return n + n
}

var c = Celsius{degrees: 21}
var r = doubleIt(c)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConversionOperator_WithMultipleParameters_ReportsGS0393()
    {
        var source = @"
struct Box {
    var v int32
}

func operator implicit (a Box, b int32) int32 {
    return a.v
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0393");
    }

    [Fact]
    public void ConversionOperator_NeitherTypeIsOwner_ReportsGS0394()
    {
        var source = @"
struct Box {
    var v int32
}

func operator implicit (x int32) string {
    return ""x""
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0394");
    }

    [Fact]
    public void DuplicateConversionOperator_ReportsGS0395()
    {
        var source = @"
struct Box {
    var v int32
}

func operator implicit (b Box) int32 {
    return b.v
}

func operator explicit (b Box) int32 {
    return b.v
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0395");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
