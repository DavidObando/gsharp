// <copyright file="Issue2991LambdaMethodIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2991: interpreter delegates preserve compiler lambda method identity.
/// </summary>
public class Issue2991LambdaMethodIdentityTests
{
    [Fact]
    public void Lambda_DistinctSites_HaveDistinctCompilerNames()
    {
        const string Source = """
            let first () -> int32 = () -> 11
            let second () -> int32 = () -> 22
            (first, second)
            """;

        var pair = Assert.IsType<ValueTuple<Func<int>, Func<int>>>(Evaluate(Source));

        Assert.Equal("<lambda1>", pair.Item1.Method.Name);
        Assert.Equal("<lambda2>", pair.Item2.Method.Name);
        Assert.NotEqual(pair.Item1.Method, pair.Item2.Method);
        Assert.Equal(11, pair.Item1());
        Assert.Equal(22, pair.Item2());
    }

    [Fact]
    public void Lambda_SameSite_HasStableCompilerNameAndMethod()
    {
        const string Source = """
            func make(value int32) () -> int32 {
                return () -> value
            }

            let first = make(11)
            let second = make(33)
            (first, second)
            """;

        var pair = Assert.IsType<ValueTuple<Func<int>, Func<int>>>(Evaluate(Source));

        Assert.Equal("Invoke", pair.Item1.Method.Name);
        Assert.Equal(pair.Item1.Method.Name, pair.Item2.Method.Name);
        Assert.Equal(pair.Item1.Method, pair.Item2.Method);
        Assert.Equal(11, pair.Item1());
        Assert.Equal(33, pair.Item2());
    }

    [Fact]
    public void Lambda_DistinctCapturingSites_HaveDistinctMethods()
    {
        const string Source = """
            func makeFirst(value int32) () -> int32 {
                return () -> value
            }

            func makeSecond(value int32) () -> int32 {
                return () -> value * 2
            }

            let first = makeFirst(11)
            let second = makeSecond(11)
            (first, second)
            """;

        var pair = Assert.IsType<ValueTuple<Func<int>, Func<int>>>(Evaluate(Source));

        Assert.Equal("Invoke", pair.Item1.Method.Name);
        Assert.Equal("Invoke", pair.Item2.Method.Name);
        Assert.NotEqual(pair.Item1.Method, pair.Item2.Method);
        Assert.Equal(11, pair.Item1());
        Assert.Equal(22, pair.Item2());
    }

    [Fact]
    public void Lambda_ZeroCaptureHost_UsesCompilerName()
    {
        const string Source = """
            class Maker {
                func make() () -> int32 {
                    return () -> 33
                }
            }

            let value = Maker{}.make()
            (value.Method.Name, value())
            """;

        var result = Assert.IsType<ValueTuple<string, int>>(Evaluate(Source));

        Assert.Equal("Invoke", result.Item1);
        Assert.Equal(33, result.Item2);
    }

    [Fact]
    public void Lambda_GenericZeroCaptureHost_UsesCompilerName()
    {
        const string Source = """
            class Maker[T] {
                func make() () -> int32 {
                    return () -> 33
                }
            }

            let value = Maker[string]().make()
            (value.Method.Name, value())
            """;

        var result = Assert.IsType<ValueTuple<string, int>>(Evaluate(Source));

        Assert.Equal("<lambda1>", result.Item1);
        Assert.Equal(33, result.Item2);
    }

    [Fact]
    public void MethodGroup_KeepsDeclaredMethodIdentity()
    {
        const string Source = """
            func first() int32 { return 11 }
            func second() int32 { return 22 }

            let firstGroup () -> int32 = first
            let secondGroup () -> int32 = second
            (firstGroup, secondGroup)
            """;

        var pair = Assert.IsType<ValueTuple<Func<int>, Func<int>>>(Evaluate(Source));

        Assert.Equal("first", pair.Item1.Method.Name);
        Assert.Equal("second", pair.Item2.Method.Name);
        Assert.NotEqual(pair.Item1.Method, pair.Item2.Method);
        Assert.Equal(11, pair.Item1());
        Assert.Equal(22, pair.Item2());
    }

    [Fact]
    public void DelegateFactory_SameSite_SupportsDistinctDelegateTypes()
    {
        var create = typeof(Evaluator).GetMethod(
            "CreateInterpreterDelegate",
            BindingFlags.NonPublic | BindingFlags.Static,
            null,
            new[] { typeof(Type), typeof(FunctionSymbol), typeof(string), typeof(Func<object[], object>) },
            null);
        Assert.NotNull(create);
        var function = new FunctionSymbol(
            "<lambda1>",
            ImmutableArray.Create(new ParameterSymbol("value", TypeSymbol.Int32)),
            TypeSymbol.Int32);

        var first = Assert.IsType<Func<int, int>>(create.Invoke(
            null,
            new object[] { typeof(Func<int, int>), function, "<lambda1>", new Func<object[], object>(args => (int)args[0] + 11) }));
        var second = Assert.IsType<Converter<int, int>>(create.Invoke(
            null,
            new object[] { typeof(Converter<int, int>), function, "<lambda1>", new Func<object[], object>(args => (int)args[0] + 11) }));

        Assert.Equal("<lambda1>", first.Method.Name);
        Assert.Equal("<lambda1>", second.Method.Name);
        Assert.Equal(11, first(0));
        Assert.Equal(22, second(11));
    }

    private static object Evaluate(string source)
    {
        var result = new Compilation(SyntaxTree.Parse(source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        return result.Value;
    }
}
