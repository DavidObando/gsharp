// <copyright file="SmartCastTests.cs" company="GSharp">
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
/// Phase 3.C.4 — smart casts after a nil-comparison guard. Minimal version:
/// only single-variable <c>x != nil</c> / <c>x == nil</c> guards on the
/// condition of an <c>if</c> trigger narrowing inside the matching arm.
/// </summary>
public class SmartCastTests
{
    [Fact]
    public void NotEqualsNil_NarrowsInThenArm()
    {
        // Without narrowing, `var y int = x` would diagnose because x is int?.
        var source = @"
var x int? = 5
var y int = 0
if x != nil {
    y = x
}
y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void EqualsNil_DoesNotNarrowThenArm()
    {
        // Narrowing must not happen in the wrong arm.
        var source = @"
var x int? = 5
var y int = 0
if x == nil {
    y = x
}
y
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void NilLiteralOnLeft_AlsoNarrows()
    {
        var source = @"
var x int? = 7
var y int = 0
if nil != x {
    y = x
}
y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NarrowingDoesNotLeakAfterIf()
    {
        // Outside the guarded block, x is still nullable.
        var source = @"
var x int? = 1
if x != nil {
    var t int = x
}
var z int = x
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
