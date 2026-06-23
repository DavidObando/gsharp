// <copyright file="SwitchExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
/// Phase 6.1: <c>switch</c> expression binding and interpretation.
/// </summary>
public class SwitchExpressionTests
{
    [Fact]
    public void SwitchExpression_IntDiscriminant_StringArms_HasStringType()
    {
        var scope = BindGlobalScope(@"
let v = 1
let label = switch v { case 1: ""one"" default: ""many"" }
");

        Assert.Empty(scope.Diagnostics);
        Assert.Equal(TypeSymbol.String, scope.Variables.Single(v => v.Name == "label").Type);
    }

    [Fact]
    public void SwitchExpression_MissingDefault_Diagnoses()
    {
        var diagnostics = Bind(@"
let v = 1
let label = switch v { case 1: ""one"" }
");

        Assert.Contains(diagnostics, d => d.Message == "Switch expression must have a 'default' arm.");
    }

    [Fact]
    public void SwitchExpression_DuplicateDefault_Diagnoses()
    {
        var diagnostics = Bind(@"
let v = 1
let label = switch v { default: ""one"" default: ""many"" }
");

        Assert.Contains(diagnostics, d => d.Message.Contains("default", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void SwitchExpression_ArmResultTypeMismatch_Diagnoses()
    {
        var diagnostics = Bind(@"
let v = 1
let label = switch v { case 1: ""one"" default: 2 }
");

        Assert.Contains(diagnostics, d => d.Message.Contains("All switch-expression arms must produce the same type", System.StringComparison.Ordinal));
    }

    [Fact]
    public void SwitchExpression_CaseValueTypeMismatch_Diagnoses()
    {
        var diagnostics = Bind(@"
let v = 1
let label = switch v { case ""one"": ""one"" default: ""many"" }
");

        Assert.Contains(diagnostics, d => d.Message.Contains("Switch case value", System.StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("1", "one")]
    [InlineData("2", "two")]
    [InlineData("3", "many")]
    public void SwitchExpression_IntDiscriminant_Evaluates(string input, string expected)
    {
        var result = Evaluate($@"
let v = {input}
let label = switch v {{ case 1: ""one"" case 2: ""two"" default: ""many"" }}
label
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void SwitchExpression_StringDiscriminant_Evaluates()
    {
        var result = Evaluate(@"
let v = ""b""
let label = switch v { case ""a"": 1 case ""b"": 2 default: 3 }
label
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Theory]
    [InlineData("true", "yes")]
    [InlineData("false", "no")]
    public void SwitchExpression_BoolDiscriminant_Evaluates(string input, string expected)
    {
        var result = Evaluate($@"
let v = {input}
let label = switch v {{ case true: ""yes"" case false: ""no"" default: ""maybe"" }}
label
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void SwitchExpression_BoolDiscriminant_DefaultFallthrough_Evaluates()
    {
        var result = Evaluate(@"
let v = false
let label = switch v { case true: ""yes"" default: ""maybe"" }
label
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("maybe", result.Value);
    }

    // Issue #991: `when` guards on switch-expression arms.
    [Theory]
    [InlineData("5", "small")]
    [InlineData("50", "big")]
    [InlineData("-1", "nonpositive")]
    public void SwitchExpression_WhenGuard_Evaluates(string input, string expected)
    {
        var result = Evaluate($@"
let v = {input}
let label = switch v {{ case > 0 when v < 10: ""small"" case > 0: ""big"" default: ""nonpositive"" }}
label
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void SwitchExpression_GuardedDiscard_DoesNotSatisfyExhaustiveness()
    {
        // Issue #991: a guarded discard (`case _ when …`) can fail at runtime,
        // so it does not act as a total/default arm — the value switch is
        // still missing a default.
        var diagnostics = Bind(@"
let v = 1
let label = switch v { case > 0: ""pos"" case _ when v < 0: ""neg"" }
");

        Assert.Contains(diagnostics, d => d.Message == "Switch expression must have a 'default' arm.");
    }

    [Fact]
    public void SwitchExpression_NonBoolGuard_Diagnoses()
    {
        // Issue #991: a non-bool guard reports the standard conversion error.
        var diagnostics = Bind(@"
let v = 1
let label = switch v { case > 0 when v: ""x"" default: ""y"" }
");

        Assert.Contains(diagnostics, d => d.Message.Contains("Cannot convert type", System.StringComparison.Ordinal) && d.Message.Contains("'bool'", System.StringComparison.Ordinal));
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
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new System.Collections.Generic.Dictionary<VariableSymbol, object>());
    }
}
