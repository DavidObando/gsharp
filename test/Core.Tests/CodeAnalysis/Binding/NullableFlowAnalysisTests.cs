// <copyright file="NullableFlowAnalysisTests.cs" company="GSharp">
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
/// Phase 6.6 — nullable flow-analysis hardening for pattern arms and imported
/// CLR <c>[NotNullWhen]</c> contracts.
/// </summary>
public class NullableFlowAnalysisTests
{
    [Fact]
    public void SwitchStatement_TypePattern_NarrowsDiscriminantInArmBody()
    {
        var result = Evaluate(@"
let s string? = ""hello""
switch s {
case x is string { var len = s.Length }
default { }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SwitchStatement_NonNilConstantPattern_NarrowsNullableValueInArmBody()
    {
        var result = Evaluate(@"
let n int? = 42
var y int = 0
switch n {
case 42 { y = n }
default { }
}
y
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void If_NegatedIsNullOrEmpty_NarrowsThenArm()
    {
        var result = Evaluate(@"
let s string? = ""world""
if !String.IsNullOrEmpty(s) {
    var len = s.Length
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsNullOrWhiteSpace_NarrowsElseArm()
    {
        var result = Evaluate(@"
let s string? = ""world""
if String.IsNullOrWhiteSpace(s) {
} else {
    var len = s.Length
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SwitchStatement_DiscardAndDefaultArms_DoNotNarrow()
    {
        var discard = Evaluate(@"
let s string? = ""world""
switch s {
case _ { var len = s.Length }
}
");
        var defaultArm = Evaluate(@"
let s string? = ""world""
switch s {
default { var len = s.Length }
}
");

        Assert.Contains(discard.Diagnostics, d => d.Message.Contains("Cannot find member Length.", System.StringComparison.Ordinal));
        Assert.Contains(defaultArm.Diagnostics, d => d.Message.Contains("Cannot find member Length.", System.StringComparison.Ordinal));
    }

    [Fact]
    public void SwitchExpression_TypePattern_NarrowsDiscriminantInArmResult()
    {
        var result = Evaluate(@"
let s string? = ""hello""
let len = switch s { case x is string -> s.Length default -> 0 }
len
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
