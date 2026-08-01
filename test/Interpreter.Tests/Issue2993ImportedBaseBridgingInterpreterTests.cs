// <copyright file="Issue2993ImportedBaseBridgingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class Issue2993ImportedBaseBridgingInterpreterTests
{
    [Fact]
    public void ClassLiteral_RunsConstructorBeforeScalarInitializer()
    {
        var source = """
            import System

            class Counter {
                prop N int32 { get; init; }
                prop M int32 { get; set; }

                init() {
                    Console.WriteLine("ctor-ran")
                    N = 7
                }
            }

            var counter = Counter{ M: 1 }
            Console.WriteLine(counter.N)
            Console.WriteLine(counter.M)
            """;

        Assert.Equal("ctor-ran\n7\n1\n", RunSubmission(source));
    }

    [Fact]
    public void ClassLiteral_InitializesGetOnlyCollection()
    {
        var source = """
            import System
            import System.Collections.Generic

            class Bag {
                prop Items IList[int32] { get; init; }

                init() {
                    Items = List[int32]()
                }
            }

            var empty = Bag{ Items: {} }
            var filled = Bag{ Items: {1, 2} }
            var ordinary = Bag()
            ordinary.Items.Add(3)
            Console.WriteLine(empty.Items.Count)
            Console.WriteLine(filled.Items.Count)
            Console.WriteLine(ordinary.Items.Count)
            """;

        Assert.Equal("0\n2\n1\n", RunSubmission(source));
    }

    [Fact]
    public void ImportedBaseLiteral_UsesClrBacking()
    {
        var source = """
            import System
            import System.IO

            class Buffer : MemoryStream {
            }

            var literal = Buffer{}
            var ordinary = Buffer()
            Console.WriteLine(literal.CanRead)
            literal.SetLength(3)
            Console.WriteLine(literal.Length)
            Console.WriteLine(ordinary.CanRead)
            """;

        Assert.Equal("True\n3\nTrue\n", RunSubmission(source));
    }

    [Fact]
    public void ImportedBase_ObjectToString_PreservesGSharpTypeIdentity()
    {
        var source = """
            package Issue3015.Identity
            import System

            class Args : EventArgs {
            }

            Console.WriteLine(Args().ToString())
            Console.WriteLine(Args{}.ToString())
            Console.WriteLine(Args().GetType().FullName)
            """;

        Assert.Equal(
            "Issue3015.Identity.Args\nIssue3015.Identity.Args\nIssue3015.Identity.Args\n",
            RunSubmission(source));
    }

    [Fact]
    public void ImportedBase_ToStringOverride_IsHonored()
    {
        var source = """
            import System
            import System.IO

            class Writer : StringWriter {
            }

            var writer = Writer{}
            writer.Write("ok")
            Console.WriteLine(writer.ToString())
            """;

        Assert.Equal("ok\n", RunSubmission(source));
    }

    [Fact]
    public void ImportedBase_ToStringOverride_ObservesGSharpTypeIdentity()
    {
        var source = """
            package Issue3015.Identity
            import System

            class Problem : Exception {
                init() : base("boom") {
                }
            }

            Console.WriteLine(Problem().ToString().StartsWith("Issue3015.Identity.Problem: boom"))
            """;

        Assert.Equal("True\n", RunSubmission(source));
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}
