// <copyright file="Adr0157PrettyDisplaySpikeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0157 feasibility spike: a display-side pretty-printer for REPL value
/// echo, applied over values produced by real emitted execution. Proves the
/// recommended mechanism end-to-end with zero product changes: a
/// reflection-based formatter renders a plain (non-<c>data</c>) struct or
/// class structurally when — and only when — no <c>ToString</c> override
/// exists anywhere below <see cref="object"/>/<see cref="ValueType"/>, and
/// defers transparently to synthesized (<c>data</c>) or user-declared
/// (<c>override func ToString</c>) overrides otherwise. Also measures the
/// evidence the ADR's cost sections cite: formatter latency and the emitted
/// metadata cost of the rejected always-on synthesis alternative
/// (plain-struct vs <c>data</c>-struct PE size for the same program).
/// </summary>
/// <remarks>
/// This is spike evidence for docs/adr/0157-default-tostring-synthesis.md,
/// not part of any conformance gate, and the formatter here is a prototype —
/// the product implementation would live REPL-side (near
/// <c>ReplScreen</c>/<c>Cell</c>), never in emitted code. Keep it cheap.
/// </remarks>
[Collection("ConsoleIo")]
[Trait("Category", "Adr0157Spike")]
public sealed class Adr0157PrettyDisplaySpikeTests
{
    private readonly ITestOutputHelper output;

    public Adr0157PrettyDisplaySpikeTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// Today's contract (issue #3204): a plain struct emits no ToString
    /// override, so the REPL echo (<c>Cell.Value.ToString()</c>) shows the
    /// CLR type name. The display-side formatter turns exactly that case
    /// into a G# composite-literal rendering without touching emitted
    /// metadata.
    /// </summary>
    [Fact]
    public void PlainStruct_NoEmittedOverride_FormatterRendersCompositeLiteral()
    {
        var result = EmittedOracle.Evaluate("""
            struct Point {
                var X int32
                var Y int32
            }
            let p = Point{X: 1, Y: 2}
            """);

        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);

        // Pin the current world: no ToString row is emitted for a plain
        // struct — the resolved slot is System.ValueType's — and the raw
        // echo is the CLR type name (#3204's decided behavior).
        var valueType = result.Value.GetType();
        var toString = valueType.GetMethod("ToString", Type.EmptyTypes);
        Assert.NotNull(toString);
        Assert.Equal(typeof(ValueType), toString.DeclaringType);
        Assert.Equal(valueType.ToString(), result.ValueText);

        // The display-side answer: structural rendering in G# literal shape.
        Assert.Equal("Point{X: 1, Y: 2}", SpikeValueFormatter.Format(result.Value));
    }

    /// <summary>
    /// A <c>data</c> struct already carries a real emitted ToString override
    /// (ADR-0029, interop-visible). The formatter must defer to it — the
    /// transparent-override contract holds with no special-casing, because
    /// the trigger is "no override below object/ValueType".
    /// </summary>
    [Fact]
    public void DataStruct_EmittedSynthesizedOverride_WinsTransparently()
    {
        var result = EmittedOracle.Evaluate("""
            data struct Point {
                var X int32
                var Y int32
            }
            let p = Point{X: 1, Y: 2}
            """);

        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.NotNull(result.Value);

        // The synthesized override is a real emitted method on the type
        // itself — visible to interop, interpolation, and the debugger.
        var valueType = result.Value.GetType();
        var toString = valueType.GetMethod("ToString", Type.EmptyTypes);
        Assert.Equal(valueType, toString.DeclaringType);

        Assert.Equal("Point(X=1, Y=2)", SpikeValueFormatter.Format(result.Value));
    }

    /// <summary>
    /// A user-declared <c>override func ToString</c> on a plain struct
    /// (issue #2896 dispatch semantics) likewise wins transparently.
    /// </summary>
    [Fact]
    public void UserDeclaredOverride_WinsTransparently()
    {
        var result = EmittedOracle.Evaluate("""
            struct Tagged {
                var Id int32
                override func ToString() string -> "tag:11"
            }
            let t = Tagged{Id: 11}
            """);

        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.NotNull(result.Value);
        Assert.Equal("tag:11", SpikeValueFormatter.Format(result.Value));
    }

    /// <summary>
    /// The rendering contract the ADR proposes for the display formatter:
    /// nested user types render recursively, <c>nil</c> renders as the G#
    /// keyword, and strings are quoted (the echo stays close to G# literal
    /// syntax).
    /// </summary>
    [Fact]
    public void NestedClass_NilField_RendersRecursively()
    {
        var result = EmittedOracle.Evaluate("""
            class Node {
                var Name string
                var Next Node?
            }
            let leaf = Node{Name: "leaf"}
            let root = Node{Name: "root", Next: leaf}
            """);

        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.NotNull(result.Value);
        Assert.Equal(
            "Node{Name: \"root\", Next: Node{Name: \"leaf\", Next: nil}}",
            SpikeValueFormatter.Format(result.Value));
    }

    /// <summary>
    /// Reference cycles terminate with an elision marker instead of
    /// overflowing — a case an emitted always-on ToString cannot handle
    /// without runtime cycle-tracking machinery in every type.
    /// </summary>
    [Fact]
    public void ReferenceCycle_TerminatesWithElision()
    {
        var result = EmittedOracle.Evaluate("""
            class Node {
                var Name string
                var Next Node?
            }
            let a = Node{Name: "a"}
            let b = Node{Name: "b", Next: a}
            a.Next = b
            let cycle = a
            """);

        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.NotNull(result.Value);
        Assert.Equal(
            "Node{Name: \"a\", Next: Node{Name: \"b\", Next: ...}}",
            SpikeValueFormatter.Format(result.Value));
    }

    /// <summary>
    /// Collections (no ToString override on <see cref="Array"/>) render
    /// element-wise with a cap, so a huge value cannot flood the transcript.
    /// </summary>
    [Fact]
    public void Collections_RenderElementwise_WithCap()
    {
        var small = EmittedOracle.Evaluate("let xs = []int32{1, 2, 3}");
        Assert.Empty(small.Diagnostics.Where(d => d.IsError));
        Assert.Equal("[1, 2, 3]", SpikeValueFormatter.Format(small.Value));

        var large = EmittedOracle.Evaluate("let xs = []int32{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}");
        Assert.Empty(large.Diagnostics.Where(d => d.IsError));
        Assert.Equal("[1, 2, 3, 4, 5, 6, 7, 8, ...]", SpikeValueFormatter.Format(large.Value));
    }

    /// <summary>
    /// Cost evidence for the ADR. (1) Formatter latency: steady-state
    /// microseconds per Format call over a nested value — the display-side
    /// design pays only at echo time, once per cell. (2) The rejected
    /// always-on emitted alternative's metadata cost, bounded by comparing
    /// the PE size of one identical program compiled with a plain struct vs
    /// a <c>data</c> struct (the data path adds seven synthesized members,
    /// of which ToString is one).
    /// </summary>
    [Fact]
    public void CostEvidence_FormatterLatency_And_SynthesisMetadataSize()
    {
        var nested = EmittedOracle.Evaluate("""
            class Node {
                var Name string
                var Next Node?
            }
            let leaf = Node{Name: "leaf"}
            let root = Node{Name: "root", Next: leaf}
            """);
        Assert.NotNull(nested.Value);

        // Warm-up, then measure.
        _ = SpikeValueFormatter.Format(nested.Value);
        const int iterations = 1000;
        var timer = Stopwatch.StartNew();
        for (var i = 0; i < iterations; i++)
        {
            _ = SpikeValueFormatter.Format(nested.Value);
        }

        timer.Stop();
        var microsecondsPerCall = timer.Elapsed.TotalMilliseconds * 1000.0 / iterations;

        // Metadata cost of the rejected always-on synthesis, upper-bounded
        // by the full data-struct member set (ToString is 1 of its 7
        // synthesized MethodDef rows).
        var plainSize = EmitProgramSize("""
            package Spike.Cost
            import System
            struct Point {
                var X int32
                var Y int32
            }
            let p = Point{X: 1, Y: 2}
            Console.WriteLine(p.X)
            """);
        var dataSize = EmitProgramSize("""
            package Spike.Cost
            import System
            data struct Point {
                var X int32
                var Y int32
            }
            let p = Point{X: 1, Y: 2}
            Console.WriteLine(p.X)
            """);

        Assert.True(dataSize > plainSize, "data-struct synthesis should grow the PE");

        this.output.WriteLine(
            $"formatter steady-state: {microsecondsPerCall:F1} us per Format call ({iterations} iterations, nested two-node graph)");
        this.output.WriteLine(
            $"PE size, identical program: plain struct {plainSize} bytes, data struct {dataSize} bytes " +
            $"(delta {dataSize - plainSize} bytes for 7 synthesized members; ToString is 1 of the 7)");
    }

    private static long EmitProgramSize(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics));
        return peStream.Length;
    }

    /// <summary>
    /// The spike's prototype of the display-side formatter the ADR
    /// recommends (working name <c>ReplValueFormatter</c>, to live in
    /// <c>src/Repl/Engine</c>). Contract: defer to any ToString override
    /// declared below <see cref="object"/>/<see cref="ValueType"/>
    /// (synthesized <c>data</c> members, user overrides, imported CLR types,
    /// primitives); otherwise render structurally in G# literal shape —
    /// <c>Name{Member: value, ...}</c> — with <c>nil</c> for null, quoted
    /// strings, element-wise capped collections, a depth cap, and
    /// reference-cycle elision. The format is explicitly diagnostics-only,
    /// never a spec guarantee.
    /// </summary>
    private static class SpikeValueFormatter
    {
        private const int MaxDepth = 4;
        private const int MaxElements = 8;
        private const string Elision = "...";

        public static string Format(object value)
            => Format(value, new HashSet<object>(ReferenceEqualityComparer.Instance), depth: 0);

        private static string Format(object value, HashSet<object> path, int depth)
        {
            if (value is null)
            {
                return "nil";
            }

            if (value is string text)
            {
                return "\"" + text + "\"";
            }

            if (value is char character)
            {
                return "'" + character + "'";
            }

            var type = value.GetType();
            if (HasToStringOverride(type))
            {
                // Any real override — synthesized data members, user
                // overrides, primitives, enums, imported CLR types — wins
                // transparently, matching CLR virtual dispatch.
                return Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;
            }

            if (depth >= MaxDepth)
            {
                return Elision;
            }

            // Reference-cycle guard: a reference value already on the
            // current rendering path elides instead of recursing forever.
            var track = !type.IsValueType;
            if (track && !path.Add(value))
            {
                return Elision;
            }

            try
            {
                return value is IEnumerable enumerable
                    ? FormatCollection(enumerable, path, depth)
                    : FormatMembers(value, type, path, depth);
            }
            finally
            {
                if (track)
                {
                    path.Remove(value);
                }
            }
        }

        private static string FormatMembers(object value, Type type, HashSet<object> path, int depth)
        {
            var parts = new List<string>();
            foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                parts.Add(field.Name + ": " + Format(field.GetValue(value), path, depth + 1));
            }

            foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!property.CanRead || property.GetIndexParameters().Length != 0)
                {
                    continue;
                }

                object propertyValue;
                try
                {
                    propertyValue = property.GetValue(value);
                }
                catch (TargetInvocationException)
                {
                    parts.Add(property.Name + ": <error>");
                    continue;
                }

                parts.Add(property.Name + ": " + Format(propertyValue, path, depth + 1));
            }

            return type.Name + "{" + string.Join(", ", parts) + "}";
        }

        private static string FormatCollection(IEnumerable enumerable, HashSet<object> path, int depth)
        {
            var parts = new List<string>();
            var truncated = false;
            foreach (var element in enumerable)
            {
                if (parts.Count == MaxElements)
                {
                    truncated = true;
                    break;
                }

                parts.Add(Format(element, path, depth + 1));
            }

            return "[" + string.Join(", ", parts) + (truncated ? ", " + Elision : string.Empty) + "]";
        }

        private static bool HasToStringOverride(Type type)
        {
            var method = type.GetMethod("ToString", Type.EmptyTypes);
            return method is not null
                && method.DeclaringType != typeof(object)
                && method.DeclaringType != typeof(ValueType);
        }
    }
}
