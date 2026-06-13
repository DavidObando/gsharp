// <copyright file="Issue799VariadicInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #799 / ADR-0101 — interpreter parity for user-declared variadic
/// (<c>...T</c>) parameters. Mirrors the emit suite
/// (<c>VariadicEmitTests</c>) so the in-process evaluator stays
/// behaviorally identical to the compiled IL on every variadic call
/// shape (pack, pass-through, empty, generic).
/// </summary>
public class Issue799VariadicInterpreterTests
{
    [Fact]
    public void Variadic_PacksTrailingArgs()
    {
        var source = """
            import System

            func sum(nums ...int32) int32 {
              var total = 0
              for v in nums {
                total = total + v
              }
              return total
            }

            Console.WriteLine(sum(1, 2, 3, 4, 5))
            """;

        Assert.Equal("15\n", Evaluate(source));
    }

    [Fact]
    public void Variadic_EmptyCall()
    {
        var source = """
            import System

            func sum(nums ...int32) int32 {
              var total = 0
              for v in nums {
                total = total + v
              }
              return total
            }

            Console.WriteLine(sum())
            """;

        Assert.Equal("0\n", Evaluate(source));
    }

    [Fact]
    public void Variadic_WithFixedPrefix()
    {
        var source = """
            import System

            func sumWithBase(base int32, extras ...int32) int32 {
              var total = base
              for v in extras {
                total = total + v
              }
              return total
            }

            Console.WriteLine(sumWithBase(100, 1, 2, 3))
            """;

        Assert.Equal("106\n", Evaluate(source));
    }

    [Fact]
    public void Variadic_Generic_PacksMultipleArgs()
    {
        var source = """
            import System

            func Of[T](values ...T) []T { return values }

            let xs = Of(1, 2, 3, 4)
            Console.WriteLine(xs.Length)
            Console.WriteLine(xs[0])
            Console.WriteLine(xs[3])
            """;

        Assert.Equal("4\n1\n4\n", Evaluate(source));
    }

    [Fact]
    public void Variadic_Generic_SingleArrayPassesThrough()
    {
        // ADR-0101 §3 — single trailing []T argument is the same array.
        var source = """
            import System

            func Of[T](values ...T) []T { return values }

            let arr = []int32{10, 20, 30}
            let xs = Of(arr)
            Console.WriteLine(xs.Length)
            Console.WriteLine(xs[1])
            """;

        Assert.Equal("3\n20\n", Evaluate(source));
    }

    [Fact]
    public void Variadic_Generic_EmptyCall()
    {
        var source = """
            import System

            func Of[T](values ...T) []T { return values }

            let xs = Of[int32]()
            Console.WriteLine(xs.Length)
            """;

        Assert.Equal("0\n", Evaluate(source));
    }

    private static string Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);

        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var variables = new Dictionary<VariableSymbol, object>();
            var result = compilation.Evaluate(variables);

            var errors = result.Diagnostics.Where(d => d.IsError).ToList();
            Assert.True(
                errors.Count == 0,
                "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}
