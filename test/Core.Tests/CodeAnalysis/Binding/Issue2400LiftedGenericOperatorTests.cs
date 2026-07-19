// <copyright file="Issue2400LiftedGenericOperatorTests.cs" company="GSharp">
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

public class Issue2400LiftedGenericOperatorTests
{
    [Fact]
    public void ClosedGenericNullableEquality_EvaluatesLiftedNullSemantics()
    {
        var result = Evaluate(
            """
            struct Box[T] {
                var Value T
                var Rank int32
            }

            func (left Box[T]) operator ==(right Box[T]) bool -> left.Rank == right.Rank

            let present Box[string]? = Box[string]{Value: "a", Rank: 7}
            let same Box[string]? = Box[string]{Value: "b", Rank: 7}
            let missing Box[string]? = nil
            present == same && !(present == missing) && missing == missing
            """);

        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.True((bool)result.Value);
    }

    [Fact]
    public void ClosedGenericNullableOrdering_EvaluatesPresentAndMissingOperands()
    {
        var result = Evaluate(
            """
            struct Box[T] {
                var Value T
                var Rank int32
            }

            func (left Box[T]) operator <(right Box[T]) bool -> left.Rank < right.Rank

            let low Box[int32]? = Box[int32]{Value: 1, Rank: 1}
            let high Box[int32]? = Box[int32]{Value: 2, Rank: 2}
            let missing Box[int32]? = nil
            low < high && !(low < missing)
            """);

        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.True((bool)result.Value);
    }

    [Fact]
    public void ClosedGenericNullableArithmetic_EvaluatesAndPropagatesNil()
    {
        var present = Evaluate(
            """
            struct Box[T] {
                var Value T
                var Rank int32
            }

            func (left Box[T]) operator +(right Box[T]) int32 -> left.Rank + right.Rank

            let left Box[string]? = Box[string]{Value: "a", Rank: 20}
            let right Box[string]? = Box[string]{Value: "b", Rank: 22}
            (left + right)!!
            """);
        Assert.Empty(present.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, present.Value);

        var missing = Evaluate(
            """
            struct Box[T] {
                var Value T
                var Rank int32
            }

            func (left Box[T]) operator +(right Box[T]) int32 -> left.Rank + right.Rank

            let left Box[string]? = Box[string]{Value: "a", Rank: 20}
            let missing Box[string]? = nil
            left + missing
            """);
        Assert.Empty(missing.Diagnostics.Where(d => d.IsError));
        Assert.Null(missing.Value);
    }

    [Fact]
    public void ClosedGenericNonNullableOperator_UsesSubstitutedSignature()
    {
        var result = Evaluate(
            """
            struct Box[T] {
                var Value T
                var Rank int32
            }

            func (left Box[T]) operator +(right Box[T]) int32 -> left.Rank + right.Rank

            let left = Box[string]{Value: "a", Rank: 20}
            let right = Box[string]{Value: "b", Rank: 22}
            left + right
            """);

        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void DifferentClosedGenericOperands_DoNotBindToOneInstantiation()
    {
        var result = Evaluate(
            """
            struct Box[T] {
                var Value T
            }

            func (left Box[T]) operator ==(right Box[T]) bool -> true

            let text Box[string]? = Box[string]{Value: "a"}
            let number Box[int32]? = Box[int32]{Value: 1}
            text == number
            """);

        Assert.Contains(result.Diagnostics, d => d.IsError);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
