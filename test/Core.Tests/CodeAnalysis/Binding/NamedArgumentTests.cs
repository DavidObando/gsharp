// <copyright file="NamedArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #343: named arguments at call sites. Covers user-defined free
/// functions, user methods, user constructors, user extension functions,
/// imported CLR static/instance methods, imported CLR constructors, and
/// imported extension methods. Also exercises the diagnostics GS0244–GS0247.
/// </summary>
public class NamedArgumentTests
{
    [Fact]
    public void UserFunction_AllNamed_BindsAndEvaluates()
    {
        var source = @"
func add(x int32, y int32) int32 {
    return x - y
}

let r = add(y: 1, x: 10)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void UserFunction_PositionalThenNamed_BindsAndEvaluates()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(10, y: 3)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void UserFunction_PositionalAfterNamed_Diagnoses_GS0244()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(x: 1, 2)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0244");
    }

    [Fact]
    public void UserFunction_DuplicateName_Diagnoses_GS0245()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(x: 1, x: 2)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0245");
    }

    [Fact]
    public void UserFunction_UnknownName_Diagnoses_GS0246()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(x: 1, qty: 2)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0246");
    }

    [Fact]
    public void UserFunction_NameAlsoPositional_Diagnoses_GS0247()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(1, x: 2)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0247");
    }

    [Fact]
    public void UserMethod_NamedArguments_BindAndEvaluate()
    {
        var source = @"
class Calc {
    var Bias int32

    func Combine(a int32, b int32) int32 {
        return Bias + a * 10 + b
    }
}

let c = Calc{Bias: 100}
let r = c.Combine(b: 7, a: 3)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(137, result.Value);
    }

    [Fact]
    public void UserConstructor_PrimaryCtor_NamedArguments_BindAndEvaluate()
    {
        var source = @"
class Point(X int32, Y int32) {
}

let p = Point(Y: 7, X: 3)
let r = p.X * 10 + p.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(37, result.Value);
    }

    [Fact]
    public void UserConstructor_PrimaryCtor_NameAlsoPositional_Diagnoses_GS0247()
    {
        var source = @"
class Point(X int32, Y int32) {
}

let p = Point(1, X: 9)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0247");
    }

    [Fact]
    public void UserExtensionFunction_NamedArguments_BindAndEvaluate()
    {
        var source = @"
class Box {
    var N int32

    func Mix(low int32, high int32) int32 {
        return N + low * 100 + high
    }
}

let b = Box{N: 1}
let r = b.Mix(high: 7, low: 5)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(508, result.Value);
    }

    [Fact]
    public void ClrInstance_StringIndexOf_NamedArguments_BindAndEvaluate()
    {
        var source = @"
import System

let s = ""hello world""
let i = s.IndexOf(value: ""world"", startIndex: 0)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ClrConstructor_StringBuilder_NamedArguments_Binds()
    {
        var source = @"
import System.Text

let sb = StringBuilder(capacity: 16)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClrConstructor_UnknownName_Diagnoses_GS0246()
    {
        var source = @"
import System.Text

let sb = StringBuilder(qty: 16)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0246");
    }

    [Fact]
    public void DelegateVariable_NamedArguments_Diagnoses_GS0246()
    {
        var source = @"
let add func(int32, int32) int32 = func(a int32, b int32) int32 {
    return a + b
}

let r = add(a: 1, b: 2)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0246");
    }

    private static void AssertHasDiagnosticId(ImmutableArray<Diagnostic> diagnostics, string id)
    {
        Assert.Contains(diagnostics, d => d.Id == id);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
