// <copyright file="PatternEvaluationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Interpreter coverage for Phase 6.2 switch patterns.</summary>
public class PatternEvaluationTests
{
    [Fact]
    public void SwitchExpression_ConstantPattern_Evaluates()
    {
        AssertEvaluates(@"
let v = 1
let x = switch v { case 1 -> ""one"" default -> ""other"" }
x
", "one");
    }

    [Fact]
    public void SwitchExpression_DiscardPattern_Evaluates()
    {
        AssertEvaluates(@"
let v = true
let x = switch v { case _ -> 7 }
x
", 7);
    }

    [Fact]
    public void SwitchExpression_TypePattern_EvaluatesAndBindsVariable()
    {
        AssertEvaluates(@"
type User class { Name string }
let u = User{Name: ""x""}
let x = switch u { case v is User -> v.Name default -> ""n"" }
x
", "x");
    }

    [Fact]
    public void SwitchExpression_PropertyPattern_Evaluates()
    {
        AssertEvaluates(@"
type User class { Name string Age int32 }
let u = User{Name: ""x"", Age: 1}
let x = switch u { case { Name: ""x"", Age: > 0 } -> ""hit"" default -> ""miss"" }
x
", "hit");
    }

    [Fact]
    public void SwitchExpression_RelationalPattern_Evaluates()
    {
        AssertEvaluates(@"
let v = 3
let x = switch v { case > 0 -> ""pos"" default -> ""other"" }
x
", "pos");
    }

    [Fact]
    public void SwitchExpression_ListPattern_Evaluates()
    {
        AssertEvaluates(@"
let a = []int32{1, 2, 3}
let x = switch a { case [1, _, 3] -> ""hit"" default -> ""miss"" }
x
", "hit");
    }

    [Fact]
    public void SwitchStatement_RelationalPattern_Evaluates()
    {
        AssertEvaluates(@"
let v = 2
var x = """"
switch v { case > 0 { x = ""pos"" } default { x = ""other"" } }
x
", "pos");
    }

    private static void AssertEvaluates(string source, object expected)
    {
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
