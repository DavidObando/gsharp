// <copyright file="Issue2993StructLiteralConstructionTests.cs" company="GSharp">
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
/// Issues #2993 and #2996: class literals must run construction before applying
/// their explicit member initializers.
/// </summary>
public class Issue2993StructLiteralConstructionTests
{
    [Fact]
    public void ClassLiteral_RunsConstructorBeforeExplicitInitializers()
    {
        const string Source = """
            import System

            class Counter {
                prop N int32 { get; init; }
                prop M int32 { get; set; }

                init() {
                    Console.WriteLine("ctor-ran")
                    N = 7
                    M = 9
                }
            }

            var c = Counter{ M: 1 }
            Console.WriteLine(c.N)
            Console.WriteLine(c.M)
            """;

        Assert.Equal($"ctor-ran{Environment.NewLine}7{Environment.NewLine}1{Environment.NewLine}", Evaluate(Source));
    }

    [Fact]
    public void ClassLiteral_PreservesConstructorInitializedCollection()
    {
        const string Source = """
            import System
            import System.Collections.Generic

            class Bag {
                prop Items IList[int32] { get; init; }

                init() {
                    Items = List[int32]()
                }
            }

            var b = Bag{ Items: {} }
            Console.WriteLine(b.Items.Count)
            """;

        Assert.Equal($"0{Environment.NewLine}", Evaluate(Source));
    }

    [Fact]
    public void ClassLiteral_AllocatesImportedBaseBacking()
    {
        const string Source = """
            import System
            import System.IO

            class Buffer : MemoryStream {
                func Describe(label string) string {
                    return label
                }
            }

            var b = Buffer{}
            Console.WriteLine(b.CanRead)
            """;

        Assert.Equal($"True{Environment.NewLine}", Evaluate(Source));
    }

    [Fact]
    public void ClassLiteral_WithPrimaryConstructor_AllocatesImportedBaseBacking()
    {
        const string Source = """
            import System
            import System.IO

            class Buffer(Label string) : MemoryStream {
            }

            var b = Buffer{ Label: "primary" }
            Console.WriteLine(b.CanRead)
            """;

        Assert.Equal($"True{Environment.NewLine}", Evaluate(Source));
    }

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);
        var errors = result.Diagnostics.Where(d => d.IsError).ToArray();
        Assert.True(
            errors.Length == 0,
            "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));

        return result.Output.ReplaceLineEndings(Environment.NewLine);
    }
}
