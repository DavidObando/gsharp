// <copyright file="Issue818AnonymousFunctionTypeVariadicEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #818: Emitted-oracle coverage for anonymous function type variadic.
/// </summary>
public class Issue818AnonymousFunctionTypeVariadicEmittedOracleTests
{
    [Fact]
    public void AnonymousVariadicLocal_AutoPacks_TrailingArgs()
    {
        var source = """
            import System

            let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

            Console.WriteLine(f(1, "a", "b", "c"))
            """;

        Assert.Equal($"4{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void AnonymousVariadicLocal_PassThroughSlice()
    {
        var source = """
            import System

            let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

            Console.WriteLine(f(10, []string{"x", "y"}))
            """;

        Assert.Equal($"12{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void AnonymousVariadicLocal_Empty_ProducesEmptySlice()
    {
        var source = """
            import System

            let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

            Console.WriteLine(f(7))
            """;

        Assert.Equal($"7{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void AnonymousVariadicLocal_NoFixed_PacksAllArgs()
    {
        var source = """
            import System

            let g (...int32) -> int32 = (xs) -> xs.Length

            Console.WriteLine(g(1, 2, 3, 4, 5))
            Console.WriteLine(g())
            """;

        Assert.Equal($"5{Environment.NewLine}0{Environment.NewLine}", Evaluate(source));
    }

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);

        var errors = result.Diagnostics.Where(d => d.IsError).ToList();
        Assert.True(
            errors.Count == 0,
            "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));
        return result.Output.ReplaceLineEndings(Environment.NewLine);
    }
}
