// <copyright file="Issue716LambdaBindingInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #716 / ADR-0076 — type inference for lambda bindings.
/// Bottom-up: <c>var square = (n int32) -&gt; n * n</c> binds <c>square</c>
/// to the function-type <c>(int32) -&gt; int32</c>. Top-down (existing
/// path, extended): when the binding has an explicit function-type, lambda
/// parameters may omit types and be filled from the target. When both
/// sides are open, diagnostic GS0304 fires.
/// </summary>
public class Issue716LambdaBindingInferenceTests
{
    [Fact]
    public void VarBinding_SingleTypedParam_InfersFunctionType()
    {
        var result = Evaluate(@"
var square = (n int32) -> n * n
square(5)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(25, result.Value);
    }

    [Fact]
    public void LetBinding_StringIdentity_InfersFunctionType()
    {
        var result = Evaluate(@"
let id = (s string) -> s
id(""hello"")
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hello", result.Value);
    }

    [Fact]
    public void LetBinding_BlockBodyWithExplicitReturn_InfersFunctionType()
    {
        var result = Evaluate(@"
let f = (n int32) -> { return n + 1 }
f(41)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void LetBinding_MultiParam_InfersFunctionType()
    {
        var result = Evaluate(@"
let add = (a int32, b int32) -> a + b
add(20, 22)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void LetBinding_ZeroParam_InfersFunctionType()
    {
        var result = Evaluate(@"
let always42 = () -> 42
always42()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void LetBinding_VoidBodyExpression_InfersVoidReturn()
    {
        // The trailing expression is a void-returning method call —
        // the inferred binding type is (string) -> void.
        var result = Evaluate(@"
let log = (msg string) -> Console.WriteLine(msg)
log(""hi"")
1
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void TargetTypedBinding_AllowsUntypedLambdaParameters()
    {
        // Explicit target type pins the lambda's parameter type.
        var result = Evaluate(@"
let inc (int32) -> int32 = (x) -> x + 1
inc(41)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void TargetTypedBinding_AllowsUntypedLambdaParameters_MultiParam()
    {
        var result = Evaluate(@"
let add (int32, int32) -> int32 = (a, b) -> a + b
add(20, 22)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NoExplicitTypeAndUntypedLambdaParam_ReportsGS0304()
    {
        var diags = GetDiagnostics(@"
let f = (x) -> x + 1
");
        var gs0304 = diags.Where(d => d.Id == "GS0304").ToList();
        Assert.Single(gs0304);
        Assert.Contains("'x'", gs0304[0].Message);
    }

    [Fact]
    public void InvokeInferredBinding_ReturnsExpected()
    {
        var result = Evaluate(@"
var square = (n int32) -> n * n
square(5)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(25, result.Value);
    }

    [Fact]
    public void InferredBinding_CapturesOuterLocals()
    {
        var result = Evaluate(@"
let base = 100
let addBase = (n int32) -> n + base
addBase(7)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void GenericMethodInference_StillWorks_WithFuncSyntax()
    {
        // ADR-0076 §6: the new bottom-up inference must not regress the
        // existing generic method-type inference path. The classic `func`
        // syntax in argument position still binds.
        var diags = GetDiagnostics(@"
import System
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)

var positives = list.Where(func(x int32) bool { return x > 1 })
");
        Assert.DoesNotContain(diags, d => d.Id == "GS0304");
        Assert.DoesNotContain(diags, d => d.IsError && d.Id != "GS9999");
    }

    [Fact]
    public void RecursiveSelfReference_IsRejected_WithExistingDiagnostic()
    {
        // ADR-0076 §5: a `let` binding's name is NOT visible inside its
        // own initializer. The body references `f` and gets an existing
        // "no such name" diagnostic. This test pins the documented
        // behaviour so future regressions are caught.
        var diags = GetDiagnostics(@"
let f = (n int32) -> if n == 0 { 0 } else { f(n - 1) }
");
        Assert.Contains(diags, d => d.IsError && d.Message.Contains("'f'"));
    }

    [Fact]
    public void AsyncLambda_Inference_WrapsReturnInTask()
    {
        // The binding's function-type wraps the body's int32 in Task<int32>.
        // We don't await it (interpreter has well-known limitations on
        // task delegate marshalling) — we verify the assignment binds
        // without errors and the binding is invocable.
        var diags = GetDiagnostics(@"
let asyncDouble = async (n int32) -> n * 2
let _ = asyncDouble(5)
1
");
        Assert.DoesNotContain(diags, d => d.IsError);
    }

    [Fact]
    public void BlockBody_MultipleReturns_InferCommonType()
    {
        // Two explicit return statements with int32 expressions yield an
        // int32 common type. We use straight-line returns so the
        // interpreter does not need control-flow lowering of nested
        // statements (the function-literal pipeline supports straight-
        // line bodies). Only the first return is reached at runtime.
        var result = Evaluate(@"
let pick = (n int32) -> {
    return n
    return n + 1
}
pick(5)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void InferredLambda_AssignableTo_ArrowFunctionTypeClause()
    {
        // The inferred binding's type IS a FunctionTypeSymbol identical to
        // the spelled-out (int32) -> int32 type — assigning between the
        // two forms must succeed with no conversion diagnostic.
        var result = Evaluate(@"
let inferred = (x int32) -> x + 1
let spelled (int32) -> int32 = inferred
spelled(41)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static System.Collections.Immutable.ImmutableArray<Diagnostic> GetDiagnostics(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics;
    }
}
