// <copyright file="Issue1650LocalsFrameLeakEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #1650: Emitted-session coverage for locals frame leak.
open class Issue1650LocalsFrameLeakEmittedSessionTests {
    @Fact
    func PlainCall_CaughtException_CallerLocalStillResolves() {
        // Exact repro from issue #1650.
        let source = `func boom() {
    throw Exception("boom")
}
func run() string {
    let name = "orig"
    try {
        boom()
    } catch (e Exception) {
    }
    return name
}
Console.WriteLine(run())`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("orig", output)
    }

    @Fact
    func NoThrow_PlainCall_StillWorks() {
        // Normal (no-exception) path must behave identically to before.
        let source = `func helper(x int32) int32 {
    return x + 1
}
func run() int32 {
    let a = 10
    let b = helper(a)
    return a + b
}
Console.WriteLine(run())`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("21", output)
    }

    @Fact
    func PropertyGetter_CaughtException_CallerLocalStillResolves() {
        let source = `class Boom {
    prop Value int32 {
        get {
            throw Exception("getter-boom")
        }
    }
}
func run() string {
    let name = "orig"
    let b = Boom{}
    try {
        var x = b.Value
    } catch (e Exception) {
    }
    return name
}
Console.WriteLine(run())`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("orig", output)
    }

    @Fact
    func PropertySetter_CaughtException_CallerLocalStillResolves() {
        let source = `class Boom {
    prop raw int32
    prop Value int32 {
        get {
            return this.raw
        }
        set(v) {
            throw Exception("setter-boom")
        }
    }
}
func run() string {
    let name = "orig"
    let b = Boom{}
    try {
        b.Value = 5
    } catch (e Exception) {
    }
    return name
}
Console.WriteLine(run())`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("orig", output)
    }

    @Fact
    func InstanceCall_CaughtException_CallerLocalStillResolves() {
        let source = `class Boom {
    func Detonate() {
        throw Exception("instance-boom")
    }
}
func run() string {
    let name = "orig"
    let b = Boom{}
    try {
        b.Detonate()
    } catch (e Exception) {
    }
    return name
}
Console.WriteLine(run())`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("orig", output)
    }

    @Fact
    func ClosureCall_CaughtException_CallerLocalStillResolves() {
        let source = `func run() string {
    let name = "orig"
    let boom = func() {
        throw Exception("closure-boom")
    }
    try {
        boom()
    } catch (e Exception) {
    }
    return name
}
Console.WriteLine(run())`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("orig", output)
    }

    @Fact
    func NestedCalls_ThrowCaughtTwoFramesUp_StackDepthRestored() {
        // The inner-most call throws; the exception is caught two call
        // frames up. Once caught, both the inner and middle frames must be
        // gone — a leaked frame at either depth would shadow the caller's
        // "name" local with a dead frame's dictionary, and any read through
        // it would either return a stale/wrong value or throw the
        // 'key was not present' error the bug report describes.
        let source = `func innermost() {
    throw Exception("nested-boom")
}
func middle() {
    innermost()
}
func run() string {
    let name = "orig"
    try {
        middle()
    } catch (e Exception) {
    }
    let after = "after"
    return name + "-" + after
}
Console.WriteLine(run())`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Contains("orig-after", output)
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
