// <copyright file="Issue1246CompoundAssignWideningEvaluatorTests.cs" company="GSharp">
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
/// Issue #1246: the tree-interpreter (Evaluator) must produce the correct
/// runtime value for a compound assignment whose right operand widens into the
/// LHS integer type, mirroring the equivalent <c>a = a + b</c>. The inserted
/// widening conversion is evaluated before the operation and the result is
/// stored back into the LHS.
/// </summary>
public class Issue1246CompoundAssignWideningEvaluatorTests
{
    [Fact]
    public void Int32PlusEqualsUInt8_EvaluatesWidenedSum()
    {
        var source = @"
var a int32 = 200
var b uint8 = 100
a += b
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(300, vars["a"]);
    }

    [Fact]
    public void Int64PlusEqualsInt32_EvaluatesWidenedSum()
    {
        var source = @"
var acc int64 = 4000000000
var i int32 = 1
acc += i
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(4000000001L, vars["acc"]);
    }

    [Fact]
    public void Int64PlusEqualsIntLiteral_EvaluatesSum()
    {
        var source = @"
var x int64 = 4000000000
x += 1
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(4000000001L, vars["x"]);
    }

    private static (EvaluationResult Result, Dictionary<string, object> Variables) EvaluateWithVariables(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var variables = new Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(variables);

        var namedVars = new Dictionary<string, object>();
        foreach (var kvp in variables)
        {
            namedVars[kvp.Key.Name] = kvp.Value;
        }

        return (result, namedVars);
    }
}
