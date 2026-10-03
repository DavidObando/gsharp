// <copyright file="Issue4675RecordReviewRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue4675RecordReviewRegressionTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IndirectDataBaseEquality_ComparesInheritedState(bool generic)
    {
        var result = EmittedOracle.Evaluate("""
            data class Child(Own int32) : MiddleTYPE
            open class MiddlePARAM : BasePARENT
            open data class BasePARAM : IEquatable[BasePARAM] { public var BaseValue int32 }
            Child(7)
            """.Replace("TYPE", generic ? "[int32]" : string.Empty, StringComparison.Ordinal)
                .Replace("PARAM", generic ? "[T]" : string.Empty, StringComparison.Ordinal)
                .Replace("PARENT", generic ? "[T]" : string.Empty, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
        var type = result.Value.GetType();
        var other = Activator.CreateInstance(type, new object[] { 7 });
        var dataBase = type.BaseType.BaseType;
        var field = dataBase.GetField("BaseValue");
        Assert.NotNull(field);
        field.SetValue(result.Value, 1);
        field.SetValue(other, 2);
        var baseEquality = typeof(IEquatable<>).MakeGenericType(dataBase).GetMethod("Equals");
        Assert.NotNull(baseEquality);
        Assert.Equal(false, baseEquality.Invoke(result.Value, new[] { other }));
        Assert.False(result.Value.Equals(other));
        field.SetValue(other, 1);
        Assert.Equal(true, baseEquality.Invoke(result.Value, new[] { other }));
        Assert.True(result.Value.Equals(other));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void PositionalLiteral_DoesNotConsumeHiddenInheritedField(bool tree, bool generic)
    {
        var source = """
            import System
            import System.Linq.Expressions
            open class BasePARAM { public var Value FIELD }
            data class Child(Value int32) : BaseTYPE
            CONSTRUCTION
            """.Replace("PARAM", generic ? "[T]" : string.Empty, StringComparison.Ordinal)
                .Replace("FIELD", generic ? "T" : "string", StringComparison.Ordinal)
                .Replace("TYPE", generic ? "[string]" : string.Empty, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", tree
                    ? "let expression Expression[Func[Child]] = () -> Child{Value: \"hello\"}\nexpression.Compile()()"
                    : "Child{Value: \"hello\"}", StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
        var type = result.Value.GetType();
        var field = type.BaseType.GetField("Value");
        var property = type.GetProperty("Value");
        Assert.NotNull(field);
        Assert.NotNull(property);
        Assert.Equal("hello", field.GetValue(result.Value));
        Assert.Equal(0, property.GetValue(result.Value));
    }

    [Fact]
    public void StructLiteral_PreservesThreeParameterClrConstructor()
    {
        Assert.NotNull(typeof(BoundStructLiteralExpression).GetConstructor(new[]
        {
            typeof(SyntaxNode),
            typeof(StructSymbol),
            typeof(ImmutableArray<BoundFieldInitializer>),
        }));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PositionalLiteral_RewrittenDeclaredInitializerRunsOnce(bool ordered)
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic
            class Counter {
                shared {
                    public var Values []int32 = []int32{0}
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            data struct Item(Value int32) {
                public var Marker int32 = (Counter.Values[0] = Counter.Next())
                public var Items List[int32] = List[int32]()
            }
            let item = Item{Value: 7SUFFIX}
            Counter.Count * 100 + item.Marker * 10 + Counter.Values[0]
            """.Replace("SUFFIX", ordered ? ", Items: {1}" : string.Empty, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(111, result.Value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ForwardEmittedBaseEquality_ComparesInheritedState(bool generic)
    {
        var result = EmittedOracle.Evaluate("""
            data class Child(Own int32) : BaseTYPE
            open data class BasePARAM : IEquatable[BasePARAM] { public var BaseValue int32 }
            Child(7)
            """.Replace("TYPE", generic ? "[int32]" : string.Empty, StringComparison.Ordinal)
                .Replace("PARAM", generic ? "[T]" : string.Empty, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
        var type = result.Value.GetType();
        var other = Activator.CreateInstance(type, new object[] { 7 });
        var field = type.BaseType.GetField("BaseValue");
        Assert.NotNull(field);
        field.SetValue(result.Value, 1);
        field.SetValue(other, 2);
        Assert.False(result.Value.Equals(other));
        var baseEquality = typeof(IEquatable<>).MakeGenericType(type.BaseType).GetMethod("Equals");
        Assert.NotNull(baseEquality);
        Assert.Equal(false, baseEquality.Invoke(result.Value, new[] { other }));
        field.SetValue(other, 1);
        Assert.True(result.Value.Equals(other));
        Assert.Equal(true, baseEquality.Invoke(result.Value, new[] { other }));
    }

    [Fact]
    public void SelfEquality_DoesNotOverrideUndeclaredInheritedOverload()
    {
        var result = EmittedOracle.Evaluate("""
            open class Base {
                public open func Equals(other Derived) bool -> false
            }
            data class Derived(Value int32) : Base
            let derived = Derived(7)
            let parent Base = derived
            parent.Equals(Derived(7))
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(false, result.Value);
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void StagedPositionalLiteral_RemainsAvailableInExpressionTrees(string kind)
    {
        var result = EmittedOracle.Evaluate("""
            import System
            import System.Linq.Expressions
            KIND Point(X int32)
            let expression Expression[Func[Point]] = () -> Point{X: 1}
            expression.Compile()().X
            """.Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(1, result.Value);
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void ExpressionTreeLiteral_PreservesWrittenOrderAndConstructorScope(string kind)
    {
        var result = EmittedOracle.Evaluate("""
            import System
            import System.Linq.Expressions
            class Counter {
                shared {
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            KIND Pair(A int32, B int32) {
                private let Marker int32 = A * 10 + B
                public var Extra int32
                public func Read() int32 -> Marker * 10 + Extra
            }
            let expression Expression[Func[int32, Pair]] = (offset int32) ->
                Pair{Extra: Counter.Next(), B: Counter.Next(), A: Counter.Next() + offset}
            let compiled = expression.Compile()
            let before = Counter.Count
            let first = compiled(1)
            let second = compiled(1)
            before * 1000000 + first.Read() * 1000 + second.Read()
            """.Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(421754, result.Value);
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void ExpressionTreeLiteral_PreservesGenericDefaultsAndPropertyUpdates(string kind)
    {
        var result = EmittedOracle.Evaluate("""
            import System
            import System.Linq.Expressions
            class Counter {
                shared {
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            KIND Pair[T](A T, B int32) {
                private let Marker int32 = Counter.Next()
                public prop Extra int32 { get; init; }
                public func Read() int32 -> Marker * 100 + B * 10 + Extra
            }
            let expression Expression[Func[Pair[int32]]] = () ->
                Pair[int32]{Extra: Counter.Next(), A: Counter.Next()}
            let compiled = expression.Compile()
            let before = Counter.Count
            let first = compiled()
            let second = compiled()
            before * 1000000 + first.Read() * 1000 + second.Read() + first.A * 10 + second.A
            """.Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(301629, result.Value);
    }
}
