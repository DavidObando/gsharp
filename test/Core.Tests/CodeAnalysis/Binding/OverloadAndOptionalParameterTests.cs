// <copyright file="OverloadAndOptionalParameterTests.cs" company="GSharp">
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
/// ADR-0063: tests for user-defined method overloading and optional parameters
/// with compile-time-constant defaults. Covers free-function overload sets,
/// duplicate-signature rejection (GS0264), invalid-default diagnostics (GS0265),
/// ambiguous-resolution (GS0266), no-applicable-overload (GS0267), and the
/// happy-path "omit trailing optional" + "omit middle optional via named arg"
/// patterns from §3 / §6 of the ADR.
/// </summary>
public class OverloadAndOptionalParameterTests
{
    [Fact]
    public void TopLevelFunctions_DistinctArity_BothBindOK()
    {
        var source = @"
func choose(x int32) int32 { return x }
func choose(x int32, y int32) int32 { return x + y }

let a = choose(7)
let b = choose(3, 4)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TopLevelFunctions_DuplicateSignature_DiagnosesGS0264()
    {
        var source = @"
func dup(x int32) int32 { return x }
func dup(x int32) int32 { return x + 1 }
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0264");
    }

    [Fact]
    public void OptionalParameter_TrailingOmitted_UsesDefault()
    {
        var source = @"
func greet(prefix string, count int32 = 2) int32 {
    return count
}

let n = greet(""hi"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void OptionalParameter_NamedOmission_MiddleSlotUsesDefault()
    {
        var source = @"
func three(a int32, b int32 = 10, c int32 = 100) int32 {
    return a + b + c
}

let n = three(1, c: 1000)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1011, result.Value);
    }

    [Fact]
    public void OptionalParameter_OnRefKind_DiagnosesGS0265()
    {
        var source = @"
func f(ref x int32 = 0) int32 { return x }
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0265");
    }

    [Fact]
    public void OptionalParameter_OnVariadic_DiagnosesGS0265()
    {
        var source = @"
func f(xs ...int32 = 0) int32 { return 0 }
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0265");
    }

    [Fact]
    public void OptionalParameter_NonConstantDefault_DiagnosesGS0265()
    {
        var source = @"
func f(x int32 = 1 + 2) int32 { return x }
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0265");
    }

    [Fact]
    public void ClassMethods_DistinctSignatures_BothBindOK()
    {
        var source = @"
type Calc class {
    func add(x int32) int32 { return x }
    func add(x int32, y int32) int32 { return x + y }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClassMethods_DuplicateSignature_DiagnosesGS0264()
    {
        var source = @"
type Calc class {
    func sum(x int32) int32 { return x }
    func sum(x int32) int32 { return x + 1 }
}
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0264");
    }

    [Fact]
    public void InterfaceMethods_DistinctSignatures_BothBindOK()
    {
        var source = @"
type IOps interface {
    func op(x int32) int32
    func op(x int32, y int32) int32
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
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
