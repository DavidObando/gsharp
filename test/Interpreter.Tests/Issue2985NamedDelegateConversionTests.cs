// <copyright file="Issue2985NamedDelegateConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2985: delegate values convert to user-declared named delegates.
/// </summary>
public class Issue2985NamedDelegateConversionTests
{
    public static TheoryData<string, string, object> Cases => new()
    {
        {
            "void",
            """
            delegate Recorder(value int32);

            class Box {
                var Value int32
            }

            let box = Box{}
            var record Recorder = func(value int32) {
                box.Value = value + 100
            }
            record.Invoke(7)
            box.Value
            """,
            107
        },
        {
            "value",
            """
            delegate Transformer(value int32) int32;

            var transform Transformer = func(value int32) int32 {
                return value * 2
            }
            transform.Invoke(23)
            """,
            46
        },
        {
            "generic",
            """
            delegate Mapper[T any](value T) T;

            var mapper Mapper[string] = func(value string) string {
                return value + "-generic"
            }
            mapper.Invoke("named")
            """,
            "named-generic"
        },
        {
            "variadic",
            """
            delegate Scorer(seed int32, values ...int32) int32;

            var score Scorer = func(seed int32, values ...int32) int32 {
                return seed + values.Length * 10
            }
            score(2, 4, 5, 6)
            """,
            32
        },
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void FunctionLiteral_ConvertsToNamedDelegate(string _, string source, object expected)
    {
        Assert.Equal(expected, Evaluate(source));
    }

    [Fact]
    public void ZeroParameterFunctionLiteral_ConvertsToNamedDelegate()
    {
        const string Source = """
            delegate Ticker() int32;

            var tick Ticker = func() int32 {
                return 77
            }
            tick.Invoke()
            """;

        Assert.Equal(77, Evaluate(Source));
    }

    [Fact]
    public void TwoParameterFunctionLiteral_ConvertsToNamedDelegate()
    {
        const string Source = """
            delegate Adder(left int32, right int32) int32;

            var add Adder = func(left int32, right int32) int32 {
                return left * 100 + right
            }
            add.Invoke(3, 11)
            """;

        Assert.Equal(311, Evaluate(Source));
    }

    [Fact]
    public void MethodGroup_ConvertsToNamedDelegate()
    {
        const string Source = """
            delegate Transformer(value int32) int32;

            func AddThree(value int32) int32 {
                return value + 3
            }

            var transform Transformer = AddThree
            transform.Invoke(30)
            """;

        Assert.Equal(33, Evaluate(Source));
    }

    [Fact]
    public void FunctionDelegate_ConvertsToNamedDelegateArgument()
    {
        const string Source = """
            delegate Transformer(value int32) int32;

            func Apply(transform Transformer, value int32) int32 {
                return transform.Invoke(value)
            }

            let increment (int32) -> int32 = func(value int32) int32 {
                return value + 1
            }
            Apply(increment, 10)
            """;

        Assert.Equal(11, Evaluate(Source));
    }

    [Fact]
    public void StructurallyEquivalentNamedDelegates_RemainDistinct()
    {
        const string Source = """
            delegate Alpha(value int32) int32;
            delegate Beta(value int32) int32;

            var alpha Alpha = func(value int32) int32 {
                return value * 2
            }
            var beta Beta = alpha
            """;

        var result = EmittedOracle.Evaluate(Source);

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0155", diagnostic.Id);
    }

    private static object Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);

        Assert.Empty(result.Diagnostics);
        return result.Value;
    }
}
