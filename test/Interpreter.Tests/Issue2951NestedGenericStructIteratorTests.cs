// <copyright file="Issue2951NestedGenericStructIteratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Emitted-session coverage for issue #2951 nested generic struct iterators.
/// </summary>
public class Issue2951NestedGenericStructIteratorTests
{
    [Fact]
    public void NestedStructIteratorUsesEnclosingTypeParameter()
    {
        const string Source = """
            import System

            class Wrap[T] {
                struct Cell {
                    var A T
                    func vals() sequence[T] { yield A }
                }
            }

            for value in Wrap[int32].Cell{A: 42}.vals() {
                Console.WriteLine(value)
            }
            """;

        Assert.Equal($"42{Environment.NewLine}", RunSubmission(Source));
    }

    [Fact]
    public void NestedGenericStructIteratorUsesEnclosingAndOwnTypeParameters()
    {
        const string Source = """
            import System

            class Outer[T] {
                struct Cell[U] {
                    var A T
                    var B U
                    func vals() sequence[string] { yield A.ToString() + B.ToString() }
                }
            }

            var first = Outer[int32].Cell[string]{A: 42, B: "x"}
            for value in first.vals() {
                Console.WriteLine(value)
            }

            var second = Outer[string].Cell[int32]{A: "y", B: 7}
            for value in second.vals() {
                Console.WriteLine(value)
            }
            """;

        Assert.Equal($"42x{Environment.NewLine}y7{Environment.NewLine}", RunSubmission(Source));
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

        return output.ToString().ReplaceLineEndings(Environment.NewLine);
    }
}
