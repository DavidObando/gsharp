// <copyright file="Adr0151IfLetExpressionEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Repl.Engine
import System
import System.Collections.Generic
import Xunit

/// ADR-0151 emitted-session coverage for the value-producing `if let`
/// expression. Pins which branch runs, that each initializer executes exactly
/// once, and that a failed binding short-circuits every later initializer and
/// the guard.
open class Adr0151IfLetExpressionEmittedSessionTests {
    @Fact
    func IfLetExpression_Match_YieldsThenValue() {
        let source = `func Run(s string?) string {
    return if let v = s { v } else { "none" }
}
Console.WriteLine(Run("hi"))`
        Assert.Equal("hi${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetExpression_Nil_YieldsElseValue() {
        let source = `func Run(s string?) string {
    return if let v = s { v } else { "none" }
}
Console.WriteLine(Run(nil))`
        Assert.Equal("none${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetExpression_GuardFalse_YieldsElseValue() {
        let source = `func Run(s string?) string {
    return if let v = s && v.Length > 3 { v } else { "short" }
}
Console.WriteLine(Run("hi"))
Console.WriteLine(Run("hello"))`
        Assert.Equal("short${Environment.NewLine}hello${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetExpression_EvaluatesInitializerExactlyOnce() {
        let source = `var calls = 0
func Source() string? {
    calls = calls + 1
    return "x"
}
let v = if let s = Source() { s } else { "none" }
Console.WriteLine(v)
Console.WriteLine(calls)`
        Assert.Equal("x${Environment.NewLine}1${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetExpression_ShortCircuits_LaterInitializerOnNilBinding() {
        // The first binding fails, so `Second()` must never run.
        let source = `var secondCalls = 0
func First() string? {
    return nil
}
func Second() string? {
    secondCalls = secondCalls + 1
    return "b"
}
let v = if let a = First(), let b = Second() { b } else { "none" }
Console.WriteLine(v)
Console.WriteLine(secondCalls)`
        Assert.Equal("none${Environment.NewLine}0${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetExpression_ShortCircuits_GuardOnNilBinding() {
        let source = `var guardCalls = 0
func Check() bool {
    guardCalls = guardCalls + 1
    return true
}
func Source() string? {
    return nil
}
let v = if let s = Source() && Check() { s } else { "none" }
Console.WriteLine(v)
Console.WriteLine(guardCalls)`
        Assert.Equal("none${Environment.NewLine}0${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetExpression_MultipleBindings_EvaluateLeftToRight() {
        let source = `var log = ""
func A() string? {
    log = log + "a"
    return "A"
}
func B() string? {
    log = log + "b"
    return "B"
}
let v = if let x = A(), let y = B() { x + y } else { "none" }
Console.WriteLine(v)
Console.WriteLine(log)`
        Assert.Equal("AB${Environment.NewLine}ab${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetExpression_LaterInitializerSeesEarlierBinding() {
        let source = `func Wrap(a string) string? {
    return a + "!"
}
func Run(s string?) string {
    return if let first = s, let second = Wrap(first) { second } else { "none" }
}
Console.WriteLine(Run("hi"))
Console.WriteLine(Run(nil))`
        Assert.Equal("hi!${Environment.NewLine}none${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetExpression_NullableValueTypeBinding() {
        let source = `func Run(n int32?) int32 {
    return if let v = n && v > 0 { v } else { -1 }
}
Console.WriteLine(Run(3))
Console.WriteLine(Run(-3))
Console.WriteLine(Run(nil))`
        Assert.Equal("3${Environment.NewLine}-1${Environment.NewLine}-1${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetExpression_ElseIfLetChain_PicksFirstMatchingArm() {
        let source = `func Run(a string?, b string?) string {
    return if let x = a { x } else if let y = b { y } else { "none" }
}
Console.WriteLine(Run("a", "b"))
Console.WriteLine(Run(nil, "b"))
Console.WriteLine(Run(nil, nil))`
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}none${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetExpression_BlockPrefixStatementsRunBeforeTheTail() {
        let source = `func Run(s string?) int32 {
    return if let v = s {
        let n = v.Length
        n + 1
    } else {
        0
    }
}
Console.WriteLine(Run("abc"))`
        Assert.Equal("4${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfLetStatement_StillWorks_Unchanged() {
        // Regression guard: the ADR-0071 statement form is untouched.
        let source = `var x = 0
func Run(s string?) {
    if let v = s {
        x = v.Length
    } else {
        x = -1
    }
}
Run("abcd")
Console.WriteLine(x)
Run(nil)
Console.WriteLine(x)`
        Assert.Equal("4${Environment.NewLine}-1${Environment.NewLine}", RunSubmission(source))
    }

    shared {
        private func RunSubmission(text string) string {
            // ADR-0156 Phase 3c (#3176): submissions run on the emitted engine.
            using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
            let cell = engine.Evaluate(text)
            Assert.DoesNotContain(cell.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id != "GS0286")
            return cell.Output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
