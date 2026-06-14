// <copyright file="Issue818AnonymousFunctionTypeVariadicInterpreterTests.cs" company="GSharp">
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
/// Issue #818 — interpreter parity for variadic parameters on anonymous
/// function-type clauses <c>(T1, ...T2) -&gt; R</c>. Mirrors the emit
/// suite (<c>Issue818VariadicAnonymousFunctionTypeEmitTests</c>) so the
/// in-process evaluator stays behaviorally identical to compiled IL on
/// every variadic call shape (pack, pass-through, empty).
/// </summary>
public class Issue818AnonymousFunctionTypeVariadicInterpreterTests
{
    [Fact]
    public void AnonymousVariadicLocal_AutoPacks_TrailingArgs()
    {
        var source = """
            import System

            let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

            Console.WriteLine(f(1, "a", "b", "c"))
            """;

        Assert.Equal("4\n", Evaluate(source));
    }

    [Fact]
    public void AnonymousVariadicLocal_PassThroughSlice()
    {
        var source = """
            import System

            let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

            Console.WriteLine(f(10, []string{"x", "y"}))
            """;

        Assert.Equal("12\n", Evaluate(source));
    }

    [Fact]
    public void AnonymousVariadicLocal_Empty_ProducesEmptySlice()
    {
        var source = """
            import System

            let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

            Console.WriteLine(f(7))
            """;

        Assert.Equal("7\n", Evaluate(source));
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

        Assert.Equal("5\n0\n", Evaluate(source));
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
