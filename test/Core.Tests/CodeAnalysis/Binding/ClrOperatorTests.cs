// <copyright file="ClrOperatorTests.cs" company="GSharp">
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
/// Stream C — user-defined operators on imported CLR types. Verifies that
/// binary and unary operators on types such as <see cref="TimeSpan"/> and
/// <see cref="DateTime"/> resolve to their <c>op_*</c> static methods through
/// the shared overload-resolution pipeline.
/// </summary>
public class ClrOperatorTests
{
    [Fact]
    public void TimeSpanAddition_Binds_AndProduces_TimeSpan()
    {
        var source = @"
import System

var a = TimeSpan(0, 0, 30)
var b = TimeSpan(0, 0, 15)
var c = a + b
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.IsType<TimeSpan>(result.Value);
        Assert.Equal(TimeSpan.FromSeconds(45), result.Value);
    }

    [Fact]
    public void TimeSpanSubtraction_Binds()
    {
        var source = @"
import System

var a = TimeSpan(0, 0, 30)
var b = TimeSpan(0, 0, 15)
var c = a - b
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(TimeSpan.FromSeconds(15), result.Value);
    }

    [Fact]
    public void TimeSpanUnaryNegation_Binds()
    {
        var source = @"
import System

var a = TimeSpan(0, 0, 30)
var b = -a
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(TimeSpan.FromSeconds(-30), result.Value);
    }

    [Fact]
    public void TimeSpanEquality_Binds()
    {
        var source = @"
import System

var a = TimeSpan(0, 0, 30)
var b = TimeSpan(0, 0, 30)
var c = a == b
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DateTimeMinusTimeSpan_Binds()
    {
        // Verifies cross-operand resolution: op_Subtraction declared on
        // DateTime accepts (DateTime, TimeSpan) and returns DateTime.
        var source = @"
import System

var dt = DateTime(2025, 1, 2)
var span = TimeSpan(1, 0, 0, 0)
var earlier = dt - span
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(new DateTime(2025, 1, 1), result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
