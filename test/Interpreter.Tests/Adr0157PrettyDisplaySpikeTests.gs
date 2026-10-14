// <copyright file="Adr0157PrettyDisplaySpikeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import Xunit
import Xunit.Abstractions

/// ADR-0157 feasibility spike: a display-side pretty-printer for REPL value
/// echo, applied over values produced by real emitted execution. Proves the
/// recommended mechanism end-to-end with zero product changes: a
/// reflection-based formatter renders a plain (non-`data`) struct or
/// class structurally when — and only when — no `ToString` override
/// exists anywhere below (cref:object)/(cref:ValueType), and
/// defers transparently to synthesized (`data`) or user-declared
/// (`override func ToString`) overrides otherwise. Also measures the
/// evidence the ADR's cost sections cite: formatter latency and the emitted
/// metadata cost of the rejected always-on synthesis alternative
/// (plain-struct vs `data`-struct PE size for the same program).
/// @remarks This is spike evidence for docs/adr/0157-default-tostring-synthesis.md,
/// not part of any conformance gate, and the formatter here is a prototype —
/// the product implementation would live REPL-side (near
/// `ReplScreen`/`Cell`), never in emitted code. Keep it cheap.
@Collection("ConsoleIo")
@Trait("Category", "Adr0157Spike")
class Adr0157PrettyDisplaySpikeTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    /// Today's contract (issue #3204): a plain struct emits no ToString
    /// override, so the REPL echo (`Cell.Value.ToString()`) shows the
    /// CLR type name. The display-side formatter turns exactly that case
    /// into a G# composite-literal rendering without touching emitted
    /// metadata.
    @Fact
    func PlainStruct_NoEmittedOverride_FormatterRendersCompositeLiteral() {
        let result = EmittedOracle.Evaluate(`struct Point {
    var X int32
    var Y int32
}
let p = Point{X: 1, Y: 2}`)
        Assert.Empty(result.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        // Pin the current world: no ToString row is emitted for a plain
        // struct — the resolved slot is System.ValueType's — and the raw
        // echo is the CLR type name (#3204's decided behavior).
        let valueType = result.Value!!.GetType()
        let toString MethodInfo? = valueType.GetMethod("ToString", Type.EmptyTypes)
        Assert.NotNull(toString)
        Assert.Equal(typeof(ValueType), toString!!.DeclaringType)
        Assert.Equal(valueType.ToString(), result.ValueText)
        // The display-side answer: structural rendering in G# literal shape.
        Assert.Equal("Point{X: 1, Y: 2}", SpikeValueFormatter.Format(result.Value))
    }

    /// A `data` struct already carries a real emitted ToString override
    /// (ADR-0029, interop-visible). The formatter must defer to it — the
    /// transparent-override contract holds with no special-casing, because
    /// the trigger is "no override below object/ValueType".
    @Fact
    func DataStruct_EmittedSynthesizedOverride_WinsTransparently() {
        let result = EmittedOracle.Evaluate(`data struct Point {
    var X int32
    var Y int32
}
let p = Point{X: 1, Y: 2}`)
        Assert.Empty(result.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))
        Assert.NotNull(result.Value)
        // The synthesized override is a real emitted method on the type
        // itself — visible to interop, interpolation, and the debugger.
        let valueType = result.Value!!.GetType()
        let toString MethodInfo? = valueType.GetMethod("ToString", Type.EmptyTypes)
        Assert.Equal(valueType, toString!!.DeclaringType)
        Assert.Equal("Point { X = 1, Y = 2 }", SpikeValueFormatter.Format(result.Value))
    }

    /// A user-declared `override func ToString` on a plain struct
    /// (issue #2896 dispatch semantics) likewise wins transparently.
    @Fact
    func UserDeclaredOverride_WinsTransparently() {
        let result = EmittedOracle.Evaluate(`struct Tagged {
    var Id int32
    override func ToString() string -> "tag:11"
}
let t = Tagged{Id: 11}`)
        Assert.Empty(result.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))
        Assert.NotNull(result.Value)
        Assert.Equal("tag:11", SpikeValueFormatter.Format(result.Value))
    }

    /// The rendering contract the ADR proposes for the display formatter:
    /// nested user types render recursively, `nil` renders as the G#
    /// keyword, and strings are quoted (the echo stays close to G# literal
    /// syntax).
    @Fact
    func NestedClass_NilField_RendersRecursively() {
        let result = EmittedOracle.Evaluate(`class Node {
    var Name string
    var Next Node?
}
let leaf = Node{Name: "leaf"}
let root = Node{Name: "root", Next: leaf}`)
        Assert.Empty(result.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))
        Assert.NotNull(result.Value)
        Assert.Equal(
            "Node{Name: \"root\", Next: Node{Name: \"leaf\", Next: nil}}",
            SpikeValueFormatter.Format(result.Value)
        )
    }

    /// Reference cycles terminate with an elision marker instead of
    /// overflowing — a case an emitted always-on ToString cannot handle
    /// without runtime cycle-tracking machinery in every type.
    @Fact
    func ReferenceCycle_TerminatesWithElision() {
        let result = EmittedOracle.Evaluate(`class Node {
    var Name string
    var Next Node?
}
let a = Node{Name: "a"}
let b = Node{Name: "b", Next: a}
a.Next = b
let cycle = a`)
        Assert.Empty(result.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))
        Assert.NotNull(result.Value)
        Assert.Equal("Node{Name: \"a\", Next: Node{Name: \"b\", Next: ...}}", SpikeValueFormatter.Format(result.Value))
    }

    /// Collections (no ToString override on (cref:Array)) render
    /// element-wise with a cap, so a huge value cannot flood the transcript.
    @Fact
    func Collections_RenderElementwise_WithCap() {
        let small = EmittedOracle.Evaluate("let xs = []int32{1, 2, 3}")
        Assert.Empty(small.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))
        Assert.Equal("[1, 2, 3]", SpikeValueFormatter.Format(small.Value))
        let large = EmittedOracle.Evaluate("let xs = []int32{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}")
        Assert.Empty(large.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))
        Assert.Equal("[1, 2, 3, 4, 5, 6, 7, 8, ...]", SpikeValueFormatter.Format(large.Value))
    }

    /// Cost evidence for the ADR. (1) Formatter latency: steady-state
    /// microseconds per Format call over a nested value — the display-side
    /// design pays only at echo time, once per cell. (2) The rejected
    /// always-on emitted alternative's metadata cost, bounded by comparing
    /// the PE size of one identical program compiled with a plain struct vs
    /// a `data` struct (the data path adds seven synthesized members,
    /// of which ToString is one).
    @Fact
    func CostEvidence_FormatterLatency_And_SynthesisMetadataSize() {
        let nested = EmittedOracle.Evaluate(`class Node {
    var Name string
    var Next Node?
}
let leaf = Node{Name: "leaf"}
let root = Node{Name: "root", Next: leaf}`)
        Assert.NotNull(nested.Value)
        // Warm-up, then measure.
        let _ = SpikeValueFormatter.Format(nested.Value)
        const iterations = 1000
        let timer = Stopwatch.StartNew()
        for var i = 0; i < iterations; i++ {
            let _ = SpikeValueFormatter.Format(nested.Value)
        }
        timer.Stop()
        let microsecondsPerCall = timer.Elapsed.TotalMilliseconds * 1000.0 / float64(iterations)
        // Metadata cost of the rejected always-on synthesis, upper-bounded
        // by the full data-struct member set (ToString is 1 of its 7
        // synthesized MethodDef rows).
        let plainSize = EmitProgramSize(`package Spike.Cost
import System
struct Point {
    var X int32
    var Y int32
}
let p = Point{X: 1, Y: 2}
Console.WriteLine(p.X)`)
        let dataSize = EmitProgramSize(`package Spike.Cost
import System
data struct Point {
    var X int32
    var Y int32
}
let p = Point{X: 1, Y: 2}
Console.WriteLine(p.X)`)
        Assert.True(dataSize > plainSize, "data-struct synthesis should grow the PE")
        this.output.WriteLine(
            "formatter steady-state: ${microsecondsPerCall:F1} us per Format call ($iterations iterations, nested two-node graph)"
        )
        this.output.WriteLine(
            "PE size, identical program: plain struct $plainSize bytes, data struct $dataSize bytes " +
                "(delta ${dataSize - plainSize} bytes for 7 synthesized members; ToString is 1 of the 7)"
        )
    }

    /// The spike's prototype of the display-side formatter the ADR
    /// recommends (working name `ReplValueFormatter`, to live in
    /// `src/Repl/Engine`). Contract: defer to any ToString override
    /// declared below (cref:object)/(cref:ValueType)
    /// (synthesized `data` members, user overrides, imported CLR types,
    /// primitives); otherwise render structurally in G# literal shape —
    /// `Name{Member: value, ...}` — with `nil` for null, quoted
    /// strings, element-wise capped collections, a depth cap, and
    /// reference-cycle elision. The format is explicitly diagnostics-only,
    /// never a spec guarantee.
    private shared class SpikeValueFormatter {
        private const MaxDepth int32 = 4
        private const MaxElements int32 = 8
        private const Elision string = "..."
        func Format(value object?) string -> Format(
            value,
            HashSet[object](ReferenceEqualityComparer.Instance),
            depth: 0
        )

        private func Format(value object?, path HashSet[object], depth int32) string {
            if value == nil {
                return "nil"
            }
            if value is string text {
                return "\"" + text + "\""
            }
            if value is char character {
                return "'" + character + "'"
            }
            let type = value.GetType()
            if HasToStringOverride(type) {
                // Any real override — synthesized data members, user
                // overrides, primitives, enums, imported CLR types — wins
                // transparently, matching CLR virtual dispatch.
                return Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty
            }
            if depth >= MaxDepth {
                return Elision
            }
            // Reference-cycle guard: a reference value already on the
            // current rendering path elides instead of recursing forever.
            let track = !type.IsValueType
            if track && !path.Add(value) {
                return Elision
            }
            try {
                return if value is IEnumerable enumerable {
                    FormatCollection(enumerable, path, depth)
                } else {
                    FormatMembers(value, type, path, depth)
                }
            } finally {
                if track {
                    path.Remove(value)
                }
            }
        }

        private func FormatMembers(value object, type Type, path HashSet[object], depth int32) string {
            let parts = List[string]()
            for field in type.GetFields(BindingFlags.Public | BindingFlags.Instance) {
                parts.Add(field.Name + ": " + Format(field.GetValue(value), path, depth + 1))
            }
            for property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                if !property.CanRead || property.GetIndexParameters().Length != 0 {
                    continue
                }
                var propertyValue object?
                try {
                    propertyValue = property.GetValue(value)
                } catch (TargetInvocationException) {
                    parts.Add(property.Name + ": <error>")
                    continue
                }
                parts.Add(property.Name + ": " + Format(propertyValue, path, depth + 1))
            }
            return type.Name + "{" + string.Join(", ", parts) + "}"
        }

        private func FormatCollection(enumerable IEnumerable, path HashSet[object], depth int32) string {
            let parts = List[string]()
            var truncated = false
            for element in enumerable {
                if parts.Count == MaxElements {
                    truncated = true
                    break
                }
                parts.Add(Format(element, path, depth + 1))
            }
            return "[" + string.Join(", ", parts) +
                (
                if truncated {
                    ", " + Elision
                } else {
                    string.Empty
                }
            ) +
                "]"
        }

        private func HasToStringOverride(type Type) bool {
            let method MethodInfo? = type.GetMethod("ToString", Type.EmptyTypes)
            return method != nil && method.DeclaringType != typeof(object) && method.DeclaringType != typeof(ValueType)
        }
    }

    shared {
        private func EmitProgramSize(source string) int64 {
            let compilation = Compilation(SyntaxTree.Parse(source))
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            return peStream.Length
        }
    }
}
