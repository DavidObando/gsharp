// <copyright file="Issue3003LambdaBodyLoweringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3003: function-literal bodies must be lowered before evaluation.
/// </summary>
public class Issue3003LambdaBodyLoweringTests
{
    [Fact]
    public void LambdaBody_LowersIfAndAllForForms()
    {
        const string Source = """
            let choose = func(n int32) string {
                if n > 0 {
                    return "positive"
                }
                return "zero"
            }

            let sumRange = func() int32 {
                var sum = 0
                for value in []int32{1, 2, 3} {
                    sum += value
                }
                return sum
            }

            let countEllipsis = func() int32 {
                var count = 0
                for _ in 0 ... 3 {
                    count++
                }
                return count
            }

            let countInfinite = func() int32 {
                var count = 0
                for {
                    count++
                    if count == 3 {
                        break
                    }
                }
                return count
            }

            Console.WriteLine(choose(1))
            Console.WriteLine(sumRange())
            Console.WriteLine(countEllipsis())
            Console.WriteLine(countInfinite())
            """;

        Assert.Equal($"positive{Environment.NewLine}6{Environment.NewLine}3{Environment.NewLine}3{Environment.NewLine}", Evaluate(Source));
    }

    [Fact]
    public void LambdaBody_PreservesConditionForSwitchAndMethodGroupDelegate()
    {
        const string Source = """
            func sign(n int32) string {
                if n > 0 {
                    return "positive"
                }
                return "zero"
            }

            let countTo = func(n int32) int32 {
                var count = 0
                for count < n {
                    count++
                }
                return count
            }

            let classify = func(n int32) string {
                switch n {
                    case 1 {
                        return "one"
                    }
                    default {
                        return "other"
                    }
                }
            }

            let signDelegate (int32) -> string = sign

            Console.WriteLine(countTo(3))
            Console.WriteLine(classify(1))
            Console.WriteLine(signDelegate(1))
            Console.WriteLine(signDelegate(0))
            """;

        Assert.Equal($"3{Environment.NewLine}one{Environment.NewLine}positive{Environment.NewLine}zero{Environment.NewLine}", Evaluate(Source));
    }

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);

        Assert.Empty(result.Diagnostics);

        return result.Output.ReplaceLineEndings(Environment.NewLine);
    }
}
