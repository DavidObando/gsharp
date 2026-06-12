// <copyright file="Issue714LambdaBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #714 / ADR-0074 — binder and end-to-end coverage for the new
/// arrow-lambda expression form and the deprecated switch-arm arrow
/// (GS0302) warning.
/// </summary>
public class Issue714LambdaBinderTests
{
    [Fact]
    public void Lambda_ZeroArgInvocation_ProducesExpectedValue()
    {
        var result = Evaluate(@"
let f = () -> 42
f()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Lambda_TypedParameter_AndExpressionBody_ReturnsValue()
    {
        var result = Evaluate(@"
let inc = (x int32) -> x + 1
inc(41)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Lambda_TypedParameters_AndExpressionBody_ReturnsValue()
    {
        var result = Evaluate(@"
let add = (a int32, b int32) -> a + b
add(20, 22)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Lambda_BlockBody_TrailingExpressionIsValue()
    {
        var result = Evaluate(@"
let f = (x int32) -> {
  let y = x * 2
  y + 2
}
f(20)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Lambda_CapturesOuterLocal()
    {
        var result = Evaluate(@"
let base = 40
let f = (x int32) -> x + base
f(2)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SwitchExpression_ColonArm_BindsCleanly_NoWarnings()
    {
        var result = Evaluate(@"
let n = 1
let s = switch n {
  case 0: ""zero""
  default: ""other""
}
s
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("other", result.Value);
    }

    [Fact]
    public void SwitchExpression_ArrowArm_EmitsGs0302_StillEvaluates()
    {
        var result = Evaluate(@"
let n = 0
let s = switch n {
  case 0 -> ""zero""
  default -> ""other""
}
s
");
        var warnings = result.Diagnostics.Where(d => d.Id == "GS0302").ToList();
        Assert.Equal(2, warnings.Count);
        Assert.All(warnings, w => Assert.False(w.IsError));
        // The non-warning diagnostics should be empty (i.e. the program still
        // binds and emits cleanly past the deprecation warning).
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("zero", result.Value);
    }

    [Fact]
    public void SwitchExpression_MixedArmSeparators_OnlyArrowsWarn()
    {
        var result = Evaluate(@"
let n = 1
let s = switch n {
  case 0: ""zero""
  case 1 -> ""one""
  default: ""other""
}
s
");
        var warnings = result.Diagnostics.Where(d => d.Id == "GS0302").ToList();
        Assert.Single(warnings);
        Assert.Equal("one", result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
