// <copyright file="Issue2931StructReceiverIteratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2931 interpreter parity for struct receiver iterators.
/// </summary>
public class Issue2931StructReceiverIteratorTests
{
    [Fact]
    public void StructIteratorReceiversUseValueSemantics()
    {
        const string Source = """
            import System

            struct Box {
                var N int32
                func vals() sequence[int32] { yield N }
            }

            struct Pair {
                var A int32
                var B int32

                func vals() sequence[int32] {
                    yield A
                    A = A + B
                    yield A
                    yield B
                }
            }

            class ClassBox(N int32) {
                func vals() sequence[int32] { yield N }
            }

            for value in Box{N: 100}.vals() {
                Console.WriteLine(value)
            }

            var box = Box{N: 110}
            for value in box.vals() {
                Console.WriteLine(value)
            }

            var pair = Pair{A: 160, B: 3}
            for value in pair.vals() {
                Console.WriteLine(value)
            }
            Console.WriteLine(pair.A)

            for value in ClassBox(400).vals() {
                Console.WriteLine(value)
            }
            """;

        Assert.Equal("100\n110\n160\n163\n3\n160\n400\n", RunSubmission(Source));
    }

    private static string RunSubmission(string source)
    {
        using var output = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(output);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(source);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return output.ToString().Replace("\r\n", "\n");
    }
}
