// <copyright file="Issue795DefaultExpressionBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0100 / issue #795 — binder + interpreter coverage for
/// <c>default(T)</c> and the bare <c>default</c> literal. Semantics:
/// zero-initialised value for value types, <c>nil</c> for reference
/// types and nullable types. The interpreter mirrors the emit
/// semantics, so these tests also exercise the
/// <see cref="Evaluator"/> path.
/// </summary>
public class Issue795DefaultExpressionBinderTests
{
    [Fact]
    public void DefaultOfInt32_IsZero()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var x = default(int32)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(0, vars["x"]);
    }

    [Fact]
    public void DefaultOfFloat64_IsZero()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var x = default(float64)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(0d, vars["x"]);
    }

    [Fact]
    public void DefaultOfBool_IsFalse()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var x = default(bool)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(false, vars["x"]);
    }

    [Fact]
    public void DefaultOfString_IsNil()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var x = default(string)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Null(vars["x"]);
    }

    [Fact]
    public void DefaultOfNullableInt32_IsNil()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var x = default(int32?)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Null(vars["x"]);
    }

    [Fact]
    public void DefaultOfNullableString_IsNil()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var x = default(string?)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Null(vars["x"]);
    }

    [Fact]
    public void DefaultOfUnconstrainedTypeParameter_BindsCleanly()
    {
        // Issue #795 repro — `func MakeZero[T]() T { return default(T) }`.
        // The binder must accept the shape; the closed-substitution
        // semantics (zero for value types, nil for reference types) are
        // verified by the compiled emit path (CompileAndRun) because the
        // tree-walking interpreter does not propagate generic
        // type-argument substitution into the body of a user function.
        var compilation = CompileSnippet(@"
func MakeZero[T]() T {
    return default(T)
}
");
        Assert.Empty(compilation.GlobalScope.Diagnostics);
    }

    [Fact]
    public void DefaultOfClassConstrainedTypeParameter_BindsCleanly()
    {
        var compilation = CompileSnippet(@"
func MakeZero[T class]() T {
    return default(T)
}
");
        Assert.Empty(compilation.GlobalScope.Diagnostics);
    }

    [Fact]
    public void DefaultOfStructConstrainedTypeParameter_BindsCleanly()
    {
        var compilation = CompileSnippet(@"
func MakeZero[T struct]() T {
    return default(T)
}
");
        Assert.Empty(compilation.GlobalScope.Diagnostics);
    }

    [Fact]
    public void BareDefault_InLetInitializerWithExplicitType_Works()
    {
        var (eval, vars) = EvaluateWithVariables(@"
let x int32 = default
let s string = default
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(0, vars["x"]);
        Assert.Null(vars["s"]);
    }

    [Fact]
    public void BareDefault_InVarInitializerWithExplicitType_Works()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var x int32 = default
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(0, vars["x"]);
    }

    [Fact]
    public void BareDefault_InReturn_WhenReturnTypeKnown_Works()
    {
        var (eval, vars) = EvaluateWithVariables(@"
func Zero() int32 {
    return default
}
var a = Zero()
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(0, vars["a"]);
    }

    [Fact]
    public void BareDefault_InCallArgument_TakesParameterType()
    {
        var (eval, vars) = EvaluateWithVariables(@"
func Echo(x int32) int32 {
    return x
}
var a = Echo(default)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(0, vars["a"]);
    }

    [Fact]
    public void BareDefault_InTernaryBranch_TakesSiblingType()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var a = true ? 42 : default
var b = false ? default : 7
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(42, vars["a"]);
        Assert.Equal(7, vars["b"]);
    }

    [Fact]
    public void BareDefault_WithNoTargetType_ReportsGS0362()
    {
        // `var x = default` has no target type — the variable type is
        // being inferred from the initializer, which leaves the bare
        // default unresolved.
        var compilation = CompileSnippet(@"
var x = default
");
        Assert.Contains(compilation.GlobalScope.Diagnostics, d => d.Id == "GS0362");
    }

    [Fact]
    public void BareDefault_InBothBranchesOfTernary_ReportsGS0362()
    {
        var compilation = CompileSnippet(@"
let x int32 = if true { 1 } else { 2 }
var y = true ? default : default
");
        Assert.Contains(compilation.GlobalScope.Diagnostics, d => d.Id == "GS0362");
    }

    [Fact]
    public void DefaultOfInt32_StaticType_IsInt32()
    {
        var tree = SyntaxTree.Parse(SourceText.From("var x = default(int32)\n"));
        var compilation = new Compilation(tree);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var variable = FindVariable(compilation, "x");
        Assert.Same(TypeSymbol.Int32, variable.Type);
    }

    [Fact]
    public void DefaultOfString_StaticType_IsString()
    {
        var tree = SyntaxTree.Parse(SourceText.From("var x = default(string)\n"));
        var compilation = new Compilation(tree);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var variable = FindVariable(compilation, "x");
        Assert.Same(TypeSymbol.String, variable.Type);
    }

    [Fact]
    public void SwitchDefaultArm_StillWorks_RegressionGuard()
    {
        var (eval, vars) = EvaluateWithVariables(@"
import System
var label = switch 99 {
case 1: ""one""
default: ""other""
}
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal("other", vars["label"]);
    }

    private static VariableSymbol FindVariable(Compilation compilation, string name)
    {
        foreach (var symbol in compilation.GlobalScope.Variables)
        {
            if (symbol.Name == name)
            {
                return symbol;
            }
        }

        throw new Xunit.Sdk.XunitException($"variable '{name}' not found");
    }

    private static Compilation CompileSnippet(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree);
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
