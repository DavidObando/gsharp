// <copyright file="Issue708IfLetGuardLetEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #708: Emitted-session coverage for if let guard let.
/// Traceability: ADR-0071.
open class Issue708IfLetGuardLetEmittedSessionTests {
    @Fact
    func IfLet_RunsThenWhenNonNil() {
        let source = `func Demo(s string?) {
    if let v = s {
        Console.WriteLine("got:" + v)
    }
}
Demo("hello")
Demo(nil)`
        let output = RunSubmission(source)
        Assert.Contains("got:hello", output)
        Assert.DoesNotContain("got:nil", output)
    }

    @Fact
    func IfLetElse_RoutesToElseOnNil() {
        let source = `func Demo(s string?) {
    if let v = s {
        Console.WriteLine("got:" + v)
    } else {
        Console.WriteLine("nil")
    }
}
Demo("x")
Demo(nil)`
        let output = RunSubmission(source)
        Assert.Contains("got:x", output)
        Assert.Contains("nil", output)
    }

    @Fact
    func IfLet_MultipleBindings_RequiresAllNonNil() {
        let source = `func Demo(a string?, b string?) {
    if let x = a, let y = b {
        Console.WriteLine("both:" + x + "/" + y)
    } else {
        Console.WriteLine("missing")
    }
}
Demo("a", "b")
Demo("a", nil)
Demo(nil, "b")`
        let output = RunSubmission(source)
        Assert.Contains("both:a/b", output)
        var missingCount = 0
        for line in output.Split(Environment.NewLine) {
            if line.Contains("missing") {
                missingCount++
            }
        }
        Assert.Equal(2, missingCount)
    }

    @Fact
    func GuardLet_FallsThroughOnNonNil_ExitsOnNil() {
        let source = `func Demo(s string?) {
    guard let v = s else {
        Console.WriteLine("exit")
        return
    }
    Console.WriteLine("ok:" + v)
}
Demo("hi")
Demo(nil)`
        let output = RunSubmission(source)
        Assert.Contains("ok:hi", output)
        Assert.Contains("exit", output)
    }

    @Fact
    func GuardLet_MultipleBindings_FirstNilExits() {
        let source = `func Demo(a string?, b string?) {
    guard let x = a, let y = b else {
        Console.WriteLine("exit")
        return
    }
    Console.WriteLine("both:" + x + "/" + y)
}
Demo("a", "b")
Demo("a", nil)
Demo(nil, "b")`
        let output = RunSubmission(source)
        Assert.Contains("both:a/b", output)
        var exitCount = 0
        for line in output.Split(Environment.NewLine) {
            if line.Contains("exit") {
                exitCount++
            }
        }
        Assert.Equal(2, exitCount)
    }

    @Fact
    func IfLet_NarrowedBindingExposesUnderlyingMembers() {
        // Inside the then-branch, `v` is narrowed to `string` and `.Length`
        // is callable without a further guard.
        let source = `func Demo(s string?) {
    if let v = s {
        Console.WriteLine(v.Length)
    }
}
Demo("abcd")
Demo(nil)`
        let output = RunSubmission(source)
        Assert.Contains("4", output)
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
