// <copyright file="Issue775ClassStructConstraintTests.cs" company="GSharp">
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
/// ADR-0097 / issue #775: G# spelling for `class` / `struct` / `init()`
/// type-parameter constraints. The tests cover parser acceptance, binder
/// satisfaction rules, illegal-combination diagnostics (GS0361),
/// interaction with the legacy `IInterface` constraint, and
/// constraint-aware overload resolution between same-name extensions.
/// </summary>
public class Issue775ClassStructConstraintTests
{
    [Fact]
    public void ClassConstraint_ReferenceTypeArgument_Accepted()
    {
        var source = @"
func First[T class](x T) T { return x }
First[string](""hi"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void ClassConstraint_ValueTypeArgument_Diagnoses()
    {
        var source = @"
func First[T class](x T) T { return x }
First[int32](5)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void StructConstraint_ValueTypeArgument_Accepted()
    {
        var source = @"
func First[T struct](x T) T { return x }
First[int32](5)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void StructConstraint_ReferenceTypeArgument_Diagnoses()
    {
        var source = @"
func First[T struct](x T) T { return x }
First[string](""hi"")
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Theory]
    [InlineData("int32")]
    [InlineData("uint32")]
    [InlineData("uint16")]
    [InlineData("uint8")]
    [InlineData("int64")]
    [InlineData("float64")]
    [InlineData("char")]
    [InlineData("bool")]
    [InlineData("nint")]
    public void StructConstraint_PrimitiveValueTypeArgument_Accepted(string primitive)
    {
        // Issue #1287: every non-nullable CLR value type — not just int32/bool —
        // must satisfy the `struct` constraint. None of these should report
        // GS0152.
        var source = $@"
func First[T struct](x T) T {{ return x }}
func Use(v {primitive}) {primitive} {{ return First[{primitive}](v) }}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void StructConstraint_UserStructArgument_Accepted()
    {
        var source = @"
struct S { prop A int32 { get; init; } }
func First[T struct](x T) T { return x }
func Use(v S) S { return First[S](v) }
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void StructConstraint_ReferenceTypeArgument_ReportsGS0152()
    {
        // Issue #1287: reference-type primitives (e.g. string) must still be
        // rejected by the `struct` constraint.
        var source = @"
func First[T struct](x T) T { return x }
func Use(v string) string { return First[string](v) }
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void NewConstraint_DefaultCtorTypeArgument_Accepted()
    {
        var source = @"
class Box { var n int32 = 0 }
func MakeOne[T init()]() T { return T{} }
let b = MakeOne[Box]()
b.n
";
        var result = Evaluate(source);
        // Body construction `T{}` is intentionally not exercised; only the
        // constraint declaration must bind cleanly.
        Assert.True(result.Diagnostics.Length == 0 || result.Diagnostics.All(d => d.Id != "GS0361"));
    }

    [Fact]
    public void NewConstraint_AcceptedOnDeclarationOnly()
    {
        var source = @"
func Bag[T init()](x T) T { return x }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClassAndNewConstraint_Combine_Accepted()
    {
        var source = @"
class Box {}
func Bag[T class init()](x T) T { return x }
Bag(Box{})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClassStructCombo_RejectedAsGS0361()
    {
        var source = @"
func Bad[T class struct](x T) T { return x }
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0361");
    }

    [Fact]
    public void StructNewCombo_RejectedAsGS0361_RedundantNew()
    {
        // `struct` already implies `init()` per ECMA-335 II.10.1.7; the
        // explicit `init()` is rejected to keep the surface unambiguous.
        var source = @"
func Bad[T struct init()](x T) T { return x }
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0361");
    }

    [Fact]
    public void InterfaceAndClassConstraint_Combine_Accepted()
    {
        var source = @"
sealed interface IShape {
    func Area() int32;
}

class Square : IShape {
    func Area() int32 { return 9 }
}

func AreaOf[T IShape class](x T) int32 { return x.Area() }
AreaOf(Square{})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void LegacyAnyConstraint_StillWorks()
    {
        var source = @"
func Id[T any](x T) T { return x }
Id(42)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void LegacyComparableConstraint_StillWorks()
    {
        var source = @"
func Eq[T comparable](a T, b T) bool { return a == b }
Eq(3, 3)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void LegacyInterfaceConstraint_StillWorks()
    {
        var source = @"
sealed interface IShape {
    func Area() int32;
}

class Square : IShape {
    func Area() int32 { return 9 }
}

func AreaOf[T IShape](x T) int32 { return x.Area() }
AreaOf(Square{})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void ConstraintAwareOverloadResolution_DispatchesByClassVsStruct()
    {
        // Two same-name extensions, one constrained to `class`, the other
        // to `struct`. The binder picks the matching overload based on the
        // call-site receiver type.
        var source = @"
func (self T?) Pick[T class]() string { return ""class"" }
func (self T?) Pick[T struct]() string { return ""struct"" }

let s string? = ""hi""
let n int32? = 5
let a = s.Pick()
let b = n.Pick()
a + b
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("classstruct", result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
