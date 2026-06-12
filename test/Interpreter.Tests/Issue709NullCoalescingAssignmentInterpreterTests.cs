// <copyright file="Issue709NullCoalescingAssignmentInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #709 / ADR-0072 — interpreter parity for the new <c>??=</c>
/// null-coalescing compound assignment. The binder desugars <c>??=</c>
/// into an existing <c>BoundIfStatement</c>/assignment pair, so the
/// interpreter accepts it automatically; these tests pin down end-to-end
/// behavior across the same shapes the emit suite exercises.
/// </summary>
public class Issue709NullCoalescingAssignmentInterpreterTests
{
    [Fact]
    public void Local_NullableString_AssignsWhenNil()
    {
        var source = """
            var x string? = nil
            x ??= "first"
            Console.WriteLine(x)
            x ??= "second"
            Console.WriteLine(x)
            """;
        var output = RunSubmission(source);
        Assert.Contains("first", output);
        Assert.DoesNotContain("second", output);
    }

    [Fact]
    public void Local_NullableInt32_AssignsWhenNil()
    {
        var source = """
            var n int32? = nil
            n ??= 42
            Console.WriteLine(n)
            n ??= 99
            Console.WriteLine(n)
            """;
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("99", output);
    }

    [Fact]
    public void Field_LHS_WritesThroughClassReceiver()
    {
        var source = """
            class Box {
                var Name string?
            }
            func main() {
                var b = Box{Name: nil}
                b.Name ??= "set"
                Console.WriteLine(b.Name)
                b.Name ??= "ignored"
                Console.WriteLine(b.Name)
            }
            main()
            """;
        var output = RunSubmission(source);
        Assert.Contains("set", output);
        Assert.DoesNotContain("ignored", output);
    }

    [Fact]
    public void Property_LHS_WritesThroughAutoProperty()
    {
        var source = """
            class Person {
                prop Name string?
            }
            func main() {
                var p = Person{}
                p.Name ??= "Alice"
                Console.WriteLine(p.Name)
                p.Name ??= "Bob"
                Console.WriteLine(p.Name)
            }
            main()
            """;
        var output = RunSubmission(source);
        Assert.Contains("Alice", output);
        Assert.DoesNotContain("Bob", output);
    }

    [Fact]
    public void Map_IndexerLHS_WritesWhenNil()
    {
        var source = """
            func main() {
                var m = map[string]string?{}
                m["k"] = nil
                m["k"] ??= "v"
                Console.WriteLine(m["k"])
                m["k"] ??= "ignored"
                Console.WriteLine(m["k"])
            }
            main()
            """;
        var output = RunSubmission(source);
        Assert.Contains("v", output);
        Assert.DoesNotContain("ignored", output);
    }

    [Fact]
    public void Receiver_EvaluatedOnce_RhsOnlyWhenNil()
    {
        var source = """
            class Box {
                var Name string?
            }
            var receiverCalls int32 = 0
            var rhsCalls int32 = 0
            func getBox(b Box) Box {
                receiverCalls = receiverCalls + 1
                return b
            }
            func computeRhs() string {
                rhsCalls = rhsCalls + 1
                return "v"
            }
            func main() {
                var b = Box{Name: nil}
                getBox(b).Name ??= computeRhs()
                Console.WriteLine(receiverCalls)
                Console.WriteLine(rhsCalls)
                Console.WriteLine(b.Name)
                getBox(b).Name ??= computeRhs()
                Console.WriteLine(receiverCalls)
                Console.WriteLine(rhsCalls)
                Console.WriteLine(b.Name)
            }
            main()
            """;
        var output = RunSubmission(source);
        // First call: receiver=1, rhs=1, b.Name=v.
        // Second call: receiver=2 (receiver called again),
        //              rhs still 1 (short-circuited because b.Name not nil),
        //              b.Name still v.
        var lines = output.Replace("\r\n", "\n").TrimEnd('\n').Split('\n');
        Assert.Equal("1", lines[0]);
        Assert.Equal("1", lines[1]);
        Assert.Equal("v", lines[2]);
        Assert.Equal("2", lines[3]);
        Assert.Equal("1", lines[4]);
        Assert.Equal("v", lines[5]);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString();
    }
}
