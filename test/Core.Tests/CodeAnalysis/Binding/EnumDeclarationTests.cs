// <copyright file="EnumDeclarationTests.cs" company="GSharp">
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
/// Phase 6.8 binder and evaluator coverage for enum declarations.
/// </summary>
public class EnumDeclarationTests
{
    [Fact]
    public void EnumMemberAccess_HasEnumType()
    {
        var scope = BindGlobalScope(@"
type Color enum { Red, Green, Blue }
let c = Color.Red
");

        Assert.Empty(scope.Diagnostics);
        var variable = scope.Variables.Single(v => v.Name == "c");
        var enumType = Assert.IsType<EnumSymbol>(variable.Type);
        Assert.Equal("Color", enumType.Name);
    }

    [Fact]
    public void DuplicateEnumMember_Diagnoses()
    {
        var diagnostics = Evaluate(@"
type Color enum { Red, Red }
0
").Diagnostics;

        Assert.Contains(diagnostics, d => d.Message.Contains("already declares a member", System.StringComparison.Ordinal));
    }

    [Fact]
    public void UndefinedEnumMember_Diagnoses()
    {
        var diagnostics = Evaluate(@"
type Color enum { Red }
Color.Blue
").Diagnostics;

        Assert.Contains(diagnostics, d => d.Message.Contains("does not define a member", System.StringComparison.Ordinal));
    }

    [Fact]
    public void EmptyEnum_Diagnoses()
    {
        var diagnostics = Evaluate(@"
type Color enum { }
0
").Diagnostics;

        Assert.Contains(diagnostics, d => d.Message.Contains("must declare at least one member", System.StringComparison.Ordinal));
    }

    [Fact]
    public void SwitchStatement_EnumDiscriminant_Binds()
    {
        var diagnostics = Bind(@"
type Color enum { Red, Green, Blue }
func F() {
 var color = Color.Green
 switch color {
 case Color.Red { var r = 1 }
 case Color.Green { var g = 2 }
 default { var b = 3 }
 }
}
");

        Assert.Empty(diagnostics);
    }

    [Theory]
    [InlineData("Color.Red", 1)]
    [InlineData("Color.Green", 2)]
    [InlineData("Color.Blue", 3)]
    public void SwitchStatement_EnumDiscriminant_Evaluates(string color, int expected)
    {
        var result = Evaluate($@"
type Color enum {{ Red, Green, Blue }}
var value = 0
switch {color} {{
case Color.Red {{ value = 1 }}
case Color.Green {{ value = 2 }}
default {{ value = 3 }}
}}
value
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void SwitchExpression_EnumDiscriminant_BindsAndEvaluatesDefault()
    {
        var result = Evaluate(@"
type Color enum { Red, Green, Blue }
let color = Color.Blue
let label = switch color { case Color.Red: ""red"" case Color.Green: ""green"" default: ""other"" }
label
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("other", result.Value);
    }

    [Fact]
    public void SwitchStatement_EnumCaseValueTypeMismatch_Diagnoses()
    {
        var diagnostics = Bind(@"
type Color enum { Red, Green }
func F() {
 var color = Color.Red
 switch color {
 case 0 { var value = 1 }
 }
}
");

        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void SwitchExpression_EnumCaseValueTypeMismatch_Diagnoses()
    {
        var diagnostics = Evaluate(@"
type Color enum { Red, Green }
let color = Color.Red
let label = switch color { case 0: ""red"" default: ""other"" }
label
").Diagnostics;

        Assert.Contains(diagnostics, d => d.Message.Contains("Switch case value", System.StringComparison.Ordinal));
    }

    [Fact]
    public void EnumEquality_Evaluates()
    {
        var result = Evaluate(@"
type Color enum { Red, Green }
let same = Color.Red == Color.Red
let different = Color.Red != Color.Green
same && different
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }

    private static BoundGlobalScope BindGlobalScope(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
