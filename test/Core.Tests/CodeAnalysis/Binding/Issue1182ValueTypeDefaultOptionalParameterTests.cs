// <copyright file="Issue1182ValueTypeDefaultOptionalParameterTests.cs" company="GSharp">
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
/// Issue #1182 — a value-type <c>default(T)</c> (and the equivalent zero-value
/// <c>T()</c> form) is a valid compile-time constant and must be accepted as an
/// optional-parameter default, materializing the type's all-zero value when the
/// argument is omitted at a call site (matching C#). Previously rejected with
/// GS0265. Covers BCL value types (<c>TimeSpan</c>), primitives
/// (<c>default(int32)</c>), user <c>data struct</c>s, the existing accepted
/// controls (numeric literal, <c>nil</c>), and a type-mismatch rejection.
/// </summary>
public class Issue1182ValueTypeDefaultOptionalParameterTests
{
    [Fact]
    public void BclValueType_DefaultOf_AcceptedAsOptionalDefault()
    {
        var source = @"
import System
class C { init(t TimeSpan = default(TimeSpan)) {} }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BclValueType_ZeroValueConstructorForm_AcceptedAsOptionalDefault()
    {
        var source = @"
import System
class C { init(t TimeSpan = TimeSpan()) {} }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Primitive_DefaultOf_AcceptedAsOptionalDefault()
    {
        var source = @"
func F(x int32 = default(int32)) int32 { return x }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void UserStruct_DefaultOf_AcceptedAsOptionalDefault()
    {
        var source = @"
data struct Point { var X int32 var Y int32 }
func F(p Point = default(Point)) int32 { return p.X }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Primitive_DefaultOf_OmittedAtCallSite_MaterializesZero()
    {
        var source = @"
func F(x int32 = default(int32)) int32 { return x }
let r = F()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void UserStruct_DefaultOf_OmittedAtCallSite_MaterializesAllZero()
    {
        var source = @"
data struct Point { var X int32 var Y int32 }
func F(p Point = default(Point)) int32 { return p.X + p.Y }
let r = F()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Primitive_DefaultOf_SuppliedAtCallSite_OverridesDefault()
    {
        var source = @"
func F(x int32 = default(int32)) int32 { return x }
let r = F(7)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void TypeMismatchedValueTypeDefault_DiagnosesGS0265()
    {
        var source = @"
import System
class C { init(t TimeSpan = default(int32)) {} }
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0265");
    }

    [Fact]
    public void NumericLiteralDefault_StillAccepted()
    {
        var source = @"
func F(x int32 = 5) int32 { return x }
let r = F()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void NilDefault_StillAccepted()
    {
        var source = @"
class C { init(s string? = nil) {} }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NonConstantValueTypeExpressionDefault_StillDiagnosesGS0265()
    {
        // A real parameterless construction with side effects is not a constant.
        var source = @"
func F(x int32 = 1 + 2) int32 { return x }
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0265");
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
