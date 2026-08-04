// <copyright file="Issue2991LambdaMethodIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2991: delegates preserve lambda method identity — distinct lambda
/// sites produce distinct <see cref="Delegate.Method"/> identities, the same
/// site produces a stable one, and method groups keep the declared method's
/// identity. Historically this pinned the tree-walking evaluator's synthesized
/// delegate identities (fabricated <c>&lt;lambda1&gt;</c>/<c>Invoke</c>
/// names); that machinery retired with the evaluator in ADR-0156 Phase 3c
/// (#3176). Under emitted execution the identities are the compiler's real
/// <see cref="System.Reflection.MethodInfo"/>s, so the identity relations
/// (distinct/stable/declared-name) are asserted rather than the evaluator's
/// fabricated name strings.
/// </summary>
public class Issue2991LambdaMethodIdentityTests
{
    [Fact]
    public void Lambda_DistinctSites_HaveDistinctMethods()
    {
        const string Source = """
            let first () -> int32 = () -> 11
            let second () -> int32 = () -> 22
            (first, second)
            """;

        var pair = Assert.IsType<ValueTuple<Func<int>, Func<int>>>(Evaluate(Source));

        Assert.NotEqual(pair.Item1.Method, pair.Item2.Method);
        Assert.Equal(11, pair.Item1());
        Assert.Equal(22, pair.Item2());
    }

    [Fact]
    public void Lambda_SameSite_HasStableMethod()
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

        Assert.NotEqual(pair.Item1.Method, pair.Item2.Method);
        Assert.Equal(11, pair.Item1());
        Assert.Equal(22, pair.Item2());
    }

    [Fact]
    public void Lambda_ZeroCaptureHost_HasInvokableIdentity()
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

        Assert.False(string.IsNullOrEmpty(result.Item1));
        Assert.Equal(33, result.Item2);
    }

    [Fact]
    public void Lambda_GenericZeroCaptureHost_HasInvokableIdentity()
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

        Assert.False(string.IsNullOrEmpty(result.Item1));
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

    private static object Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);

        Assert.Empty(result.Diagnostics);
        return result.Value;
    }
}
