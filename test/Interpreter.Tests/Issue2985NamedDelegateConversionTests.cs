// <copyright file="Issue2985NamedDelegateConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2985: function literals convert to user-declared named delegates.
/// </summary>
public class Issue2985NamedDelegateConversionTests
{
    public static TheoryData<string, string, object> Cases => new()
    {
        {
            "void",
            """
            type Recorder = delegate func(value int32)

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
            type Transformer = delegate func(value int32) int32

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
            type Mapper[T any] = delegate func(value T) T

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
            type Scorer = delegate func(seed int32, values ...int32) int32

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
        var result = new Compilation(SyntaxTree.Parse(source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }
}
