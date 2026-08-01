// <copyright file="Issue2990ClrDelegateBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2990: closures whose signatures contain G# types must be coerced to
/// the delegate type expected by each reflection-invoked CLR boundary.
/// </summary>
public class Issue2990ClrDelegateBoundaryTests
{
    [Fact]
    public void ImportedStaticCall_CoercesTypedAndUntypedClosures()
    {
        const string Source = """
            import System
            import System.Linq

            data struct Item {
                var V int32
            }

            var items = []Item{Item{V: 11}, Item{V: 22}, Item{V: 33}}
            Console.WriteLine(items.Where((item) -> item.V != 22).First().V)
            Console.WriteLine(items.Where((item Item) -> item.V == 22).First().V)
            """;

        Assert.Equal("11\n22\n", Evaluate(Source));
    }

    [Fact]
    public void ImportedInstanceCall_CoercesTypedAndUntypedClosures()
    {
        const string Source = """
            import System
            import System.Collections.Generic

            data struct Item {
                var V int32
            }

            var items = List[Item]()
            items.Add(Item{V: 33})
            items.Add(Item{V: 44})
            items.Add(Item{V: 55})
            Console.WriteLine(items.Find((item) -> item.V == 44).V)
            Console.WriteLine(items.Find((item Item) -> item.V == 55).V)
            """;

        Assert.Equal("44\n55\n", Evaluate(Source));
    }

    [Fact]
    public void ClrConstructor_CoercesClosureWithUserTypeReturn()
    {
        const string Source = """
            import System

            data struct Item {
                var V int32
            }

            var item = Lazy[Item](() -> Item{V: 66}).Value
            Console.WriteLine(item.V)
            """;

        Assert.Equal("66\n", Evaluate(Source));
    }

    [Fact]
    public void UserFunctionCall_PreservesRawClosure()
    {
        const string Source = """
            import System

            data struct Item {
                var V int32
            }

            func Pick(items []Item, predicate (Item) -> bool) int32 {
                for item in items {
                    if predicate(item) {
                        return item.V
                    }
                }
                return -1
            }

            var items = []Item{Item{V: 77}, Item{V: 88}, Item{V: 99}}
            Console.WriteLine(Pick(items, (item) -> item.V == 88))
            """;

        Assert.Equal("88\n", Evaluate(Source));
    }

    private static string Evaluate(string source)
    {
        using var outWriter = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var result = new Compilation(SyntaxTree.Parse(source))
                .Evaluate(new Dictionary<VariableSymbol, object>());

            Assert.Empty(result.Diagnostics);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}
