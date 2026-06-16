// <copyright file="GenericFunctionTests.cs" company="GSharp">
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
/// Phase 4.1 / ADR-0020 — generic function declarations with Go-style square
/// brackets, plus explicit and inferred type-argument lists at call sites.
/// Interpreter behaviour is type-erased: every value flows as <c>object</c>
/// so the substitution machinery only needs to satisfy the binder.
/// </summary>
public class GenericFunctionTests
{
    [Fact]
    public void GenericIdentity_InferredFromIntArgument_ReturnsInt()
    {
        var source = @"
func Identity[T any](x T) T { return x }
Identity(5)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void GenericIdentity_ExplicitTypeArgument_ReturnsString()
    {
        var source = @"
func Identity[T any](x T) T { return x }
Identity[string](""hi"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void GenericTwoParameters_Inferred_FirstWins()
    {
        var source = @"
func First[T any, U any](a T, b U) T { return a }
First(10, ""ignored"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void GenericExplicitArgs_Wrong_Arity_Diagnoses()
    {
        var source = @"
func Identity[T any](x T) T { return x }
Identity[int32, string](5)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void GenericNoArgs_CannotInfer_Diagnoses()
    {
        var source = @"
func Make[T any]() T { return Make[T]() }
Make()
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void TypeParameter_ShadowsBuiltinName_DoesNotConflict()
    {
        // `T` is freshly introduced and must not be confused with `int`/`string`.
        var source = @"
func Echo[T any](x T) T { return x }
Echo(""abc"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("abc", result.Value);
    }

    [Fact]
    public void GenericComparable_EqualsOperator_OnInt_Works()
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
    public void GenericComparable_NotEqualsOperator_OnString_Works()
    {
        var source = @"
func Neq[T comparable](a T, b T) bool { return a != b }
Neq(""hi"", ""bye"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void GenericAny_EqualsOperator_RejectedByBinder()
    {
        var source = @"
func Eq[T any](a T, b T) bool { return a == b }
Eq(3, 3)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void GenericComparable_NonComparableTypeArg_Diagnoses()
    {
        // Slices are not comparable.
        var source = @"
func Eq[T comparable](a T, b T) bool { return a == b }
Eq[[]int32]([]int32{1}, []int32{1})
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void GenericComparable_InferredNonComparableTypeArg_Diagnoses()
    {
        var source = @"
func Eq[T comparable](a T, b T) bool { return a == b }
Eq([]int32{1}, []int32{2})
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void GenericInterfaceConstraint_Dispatch_OnImplementor_Works()
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
    public void GenericInterfaceConstraint_NonImplementor_Diagnoses()
    {
        var source = @"
sealed interface IShape {
    func Area() int32;
}

class NotAShape {}

func AreaOf[T IShape](x T) int32 { return x.Area() }
AreaOf[NotAShape](NotAShape{})
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void GenericConstraint_OnNonSealedInterface_Diagnoses()
    {
        var source = @"
interface IShape {
    func Area() int32;
}

func AreaOf[T IShape](x T) int32 { return x.Area() }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("sealed"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
