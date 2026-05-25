// <copyright file="ByRefEvaluationTests.cs" company="GSharp">
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
/// ADR-0039: Evaluator (interpreter) tests for by-ref/out write-back semantics.
/// </summary>
public class ByRefEvaluationTests
{
    [Fact]
    public void IntTryParse_Success_WritesBack_Result()
    {
        var source = @"
import System
var result = 0
var ok = Int32.TryParse(""42"", &result)
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(true, vars["ok"]);
        Assert.Equal(42, vars["result"]);
    }

    [Fact]
    public void IntTryParse_Failure_WritesBack_Zero()
    {
        var source = @"
import System
var result = 99
var ok = Int32.TryParse(""notanumber"", &result)
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(false, vars["ok"]);
        Assert.Equal(0, vars["result"]);
    }

    [Fact]
    public void Dereference_Returns_Original_Value()
    {
        var source = @"
var x = 100
var p = &x
var y = *p
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(100, vars["y"]);
    }

    [Fact]
    public void AddressOf_Evaluates_To_Value_In_Interpreter()
    {
        var source = @"
var x = 55
var p = &x
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        // In the interpreter, &x just evaluates to the value of x.
        Assert.Equal(55, vars["p"]);
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
