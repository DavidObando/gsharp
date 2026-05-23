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
Identity[int, string](5)
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
Eq[[]int]([]int{1}, []int{1})
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void GenericComparable_InferredNonComparableTypeArg_Diagnoses()
    {
        var source = @"
func Eq[T comparable](a T, b T) bool { return a == b }
Eq([]int{1}, []int{2})
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
