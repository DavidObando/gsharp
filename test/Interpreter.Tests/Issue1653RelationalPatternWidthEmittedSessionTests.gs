// <copyright file="Issue1653RelationalPatternWidthEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #1653: Emitted-session coverage for relational pattern width.
/// Traceability: issue #421.
open class Issue1653RelationalPatternWidthEmittedSessionTests {
    @Fact
    func RelationalPattern_Float64_Matches() {
        let output = RunSubmission(`let v = 7.5
let r = switch v { case > 5.0: "big" default: "small" }
Console.WriteLine(r)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("big", output)
    }

    @Fact
    func RelationalPattern_Int64_Matches() {
        let output = RunSubmission(`let v = 5000000000L
let r = switch v { case > 1000000000L: "big" default: "small" }
Console.WriteLine(r)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("big", output)
    }

    @Fact
    func RelationalPattern_UInt32_Boundary_UsesUnsignedComparison() {
        // 0xFFFFFFFFu is uint.MaxValue. Sign-interpreted it is -1 and would
        // NOT satisfy `> 1u`; compared unsigned it does — matches the
        // compiled emitter's Cgt_un opcode (issue #421).
        let output = RunSubmission(`let v = 4294967295u
let r = switch v { case > 1u: "hi" default: "lo" }
Console.WriteLine(r)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("hi", output)
    }

    @Fact
    func RelationalPattern_Char_Matches() {
        let output = RunSubmission(`let c = 'z'
let r = switch c { case > 'a': "hi" default: "lo" }
Console.WriteLine(r)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("hi", output)
    }

    @Fact
    func RelationalPattern_NegativeVsUnsignedBoundary_Matches() {
        // A small unsigned value must still compare correctly below the
        // unsigned boundary (regression guard against reintroducing a
        // signed-cast shortcut for uint/ulong discriminants).
        let output = RunSubmission(`let v = 3u
let r = switch v { case < 4294967295u: "lt" default: "ge" }
Console.WriteLine(r)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("lt", output)
    }

    @Fact
    func RelationalPattern_Enum_ComparesByUnderlyingValue() {
        let output = RunSubmission(`import System
let d = DayOfWeek.Wednesday
let r = switch d { case > DayOfWeek.Monday: "later" default: "earlier-or-same" }
Console.WriteLine(r)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("later", output)
    }

    @Fact
    func RelationalPattern_Float64_NaN_NeverMatchesAnyRelation() {
        // IEEE-754: every ordered relation involving NaN is false. Must
        // agree with the compiled emitter's unordered handling (#421)
        // rather than double.CompareTo's "NaN sorts lowest" semantics.
        let output = RunSubmission(`let v = 0.0 / 0.0
let g = switch v { case > 0.0: "gt" default: "nope" }
let l = switch v { case < 0.0: "lt" default: "nope" }
let ge = switch v { case >= 0.0: "ge" default: "nope" }
let le = switch v { case <= 0.0: "le" default: "nope" }
Console.WriteLine(g)
Console.WriteLine(l)
Console.WriteLine(ge)
Console.WriteLine(le)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains(
            "nope${Environment.NewLine}nope${Environment.NewLine}nope${Environment.NewLine}nope${Environment.NewLine}",
            output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func PropertyPatternGuard_RelationalSubPatternOnDouble_Matches() {
        let output = RunSubmission(`class Reading { var Name string var Value float64 }
let r = Reading{Name: "temp", Value: 98.6}
let x = switch r { case { Name: "temp", Value: > 90.0 }: "hot" default: "normal" }
Console.WriteLine(x)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("hot", output)
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString()
        }
    }
}
