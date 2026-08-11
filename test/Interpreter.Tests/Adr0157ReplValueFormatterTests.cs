// <copyright file="Adr0157ReplValueFormatterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Repl.Engine;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0157 behavioral pins for the display-side REPL value formatter: the
/// echo sites (compat console echo, state-sidebar values) render plain
/// structs/classes structurally in G# composite-literal shape, defer
/// transparently to real <c>ToString</c> overrides (<c>data</c>-synthesized
/// per ADR-0029, user <c>override func ToString</c> per #2896), and honor
/// the rendering contract (nil, nesting, reference cycles, capped
/// collections, quoted strings). Emitted semantics stay untouched (#3204):
/// <c>Cell.Value</c> remains the raw runtime object; only its display
/// changes. Witness (ADR-0154): the echo/sidebar tests fail with the ADR's
/// three wiring hunks reverted (raw <c>ToString</c> echo shows the CLR type
/// name), and pass with them.
/// </summary>
[Collection("ConsoleIo")]
public sealed class Adr0157ReplValueFormatterTests
{
    private const string PointStructCell = """
        struct Point {
            var X int32
            var Y int32
        }
        let p = Point{X: 1, Y: 2}
        """;

    [Fact]
    public void CompatEcho_PlainStruct_RendersCompositeLiteral()
    {
        Assert.Equal($"Point{{X: 1, Y: 2}}{Environment.NewLine}", EchoOf(PointStructCell));
    }

    [Fact]
    public void CompatEcho_DataStructOverride_Unchanged()
    {
        Assert.Equal(
            $"Point(X=1, Y=2){Environment.NewLine}",
            EchoOf("""
                data struct Point {
                    var X int32
                    var Y int32
                }
                let p = Point{X: 1, Y: 2}
                """));
    }

    [Fact]
    public void CompatEcho_UserToStringOverride_Unchanged()
    {
        Assert.Equal(
            $"tag:11{Environment.NewLine}",
            EchoOf("""
                struct Tagged {
                    var Id int32
                    override func ToString() string -> "tag:11"
                }
                let t = Tagged{Id: 11}
                """));
    }

    [Fact]
    public void CompatEcho_NestedClassWithNilField_RendersRecursively()
    {
        Assert.Equal(
            $"Node{{Name: \"root\", Next: Node{{Name: \"leaf\", Next: nil}}}}{Environment.NewLine}",
            EchoOf("""
                class Node {
                    var Name string
                    var Next Node?
                }
                let leaf = Node{Name: "leaf"}
                let root = Node{Name: "root", Next: leaf}
                """));
    }

    [Fact]
    public void CompatEcho_ReferenceCycle_TerminatesWithElision()
    {
        Assert.Equal(
            $"Node{{Name: \"a\", Next: Node{{Name: \"b\", Next: ...}}}}{Environment.NewLine}",
            EchoOf("""
                class Node {
                    var Name string
                    var Next Node?
                }
                let a = Node{Name: "a"}
                let b = Node{Name: "b", Next: a}
                a.Next = b
                let cycle = a
                """));
    }

    [Fact]
    public void CompatEcho_Collections_RenderElementwiseWithCap()
    {
        Assert.Equal($"[1, 2, 3]{Environment.NewLine}", EchoOf("let xs = []int32{1, 2, 3}"));
        Assert.Equal(
            $"[1, 2, 3, 4, 5, 6, 7, 8, ...]{Environment.NewLine}",
            EchoOf("let xs = []int32{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}"));
    }

    [Fact]
    public void SidebarSnapshot_PlainStructValue_RendersFormatted()
    {
        using var engine = new EmittedSessionEngine();
        Assert.False(engine.Evaluate(PointStructCell).HasError);

        var variable = Assert.Single(engine.Snapshot().Variables);
        Assert.Contains("Point{X: 1, Y: 2}", variable.Display, StringComparison.Ordinal);
    }

    /// <summary>
    /// The formatter changes display only: <c>Cell.Value</c> stays the raw
    /// runtime object, whose own <c>ToString</c> remains the CLR type name
    /// for a plain struct — #3204's emitted semantics, pinned here so the
    /// display-side placement never leaks into the value surface.
    /// </summary>
    [Fact]
    public void CellValue_StaysRawRuntimeObject()
    {
        using var engine = new EmittedSessionEngine();
        var cell = engine.Evaluate(PointStructCell);

        Assert.False(cell.HasError);
        Assert.NotNull(cell.Value);
        Assert.Equal(cell.Value.GetType().ToString(), cell.Value.ToString());
        Assert.Equal(typeof(ValueType), cell.Value.GetType().GetMethod("ToString", Type.EmptyTypes).DeclaringType);
    }

    /// <summary>
    /// Direct contract pins on the formatter itself, over values produced by
    /// real emitted execution: primitives and other overridden types defer
    /// (invariant culture), strings quote, and nil renders as the keyword.
    /// </summary>
    [Fact]
    public void Format_DefersToOverriddenTypes_AndQuotesStrings()
    {
        Assert.Equal("42", ReplValueFormatter.Format(EmittedOracle.Evaluate("40 + 2").Value));
        Assert.Equal("True", ReplValueFormatter.Format(EmittedOracle.Evaluate("2 > 1").Value));
        Assert.Equal("\"hi\"", ReplValueFormatter.Format(EmittedOracle.Evaluate("\"h\" + \"i\"").Value));
        Assert.Equal("nil", ReplValueFormatter.Format(null));
    }

    /// <summary>
    /// Depth cap: rendering elides below the cap instead of recursing
    /// through an arbitrarily deep object graph.
    /// </summary>
    [Fact]
    public void Format_DepthCap_Elides()
    {
        var result = EmittedOracle.Evaluate("""
            class Node {
                var Name string
                var Next Node?
            }
            let n5 = Node{Name: "5"}
            let n4 = Node{Name: "4", Next: n5}
            let n3 = Node{Name: "3", Next: n4}
            let n2 = Node{Name: "2", Next: n3}
            let n1 = Node{Name: "1", Next: n2}
            """);

        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(
            "Node{Name: \"1\", Next: Node{Name: \"2\", Next: Node{Name: \"3\", Next: Node{Name: \"4\", Next: ...}}}}",
            ReplValueFormatter.Format(result.Value));
    }

    private static string EchoOf(string submission)
    {
        var previousOut = Console.Out;
        using var writer = new StringWriter { NewLine = Environment.NewLine };
        Console.SetOut(writer);
        try
        {
            using var repl = new GSharpRepl();
            repl.EvaluateSubmission(submission);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return writer.ToString().ReplaceLineEndings(Environment.NewLine);
    }
}
