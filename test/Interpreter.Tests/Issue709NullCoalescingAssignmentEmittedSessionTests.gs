// <copyright file="Issue709NullCoalescingAssignmentEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #709: Emitted-session coverage for null coalescing assignment.
/// Traceability: ADR-0072.
open class Issue709NullCoalescingAssignmentEmittedSessionTests {
    @Fact
    func Local_NullableString_AssignsWhenNil() {
        let source = `var x string? = nil
x ??= "first"
Console.WriteLine(x)
x ??= "second"
Console.WriteLine(x)`
        let output = RunSubmission(source)
        Assert.Contains("first", output)
        Assert.DoesNotContain("second", output)
    }

    @Fact
    func Local_NullableInt32_AssignsWhenNil() {
        let source = `var n int32? = nil
n ??= 42
Console.WriteLine(n)
n ??= 99
Console.WriteLine(n)`
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("99", output)
    }

    @Fact
    func Field_LHS_WritesThroughClassReceiver() {
        let source = `class Box {
    var Name string?
}
func main() {
    var b = Box{Name: nil}
    b.Name ??= "set"
    Console.WriteLine(b.Name)
    b.Name ??= "ignored"
    Console.WriteLine(b.Name)
}
main()`
        let output = RunSubmission(source)
        Assert.Contains("set", output)
        Assert.DoesNotContain("ignored", output)
    }

    @Fact
    func Property_LHS_WritesThroughAutoProperty() {
        let source = `class Person {
    prop Name string?
}
func main() {
    var p = Person{}
    p.Name ??= "Alice"
    Console.WriteLine(p.Name)
    p.Name ??= "Bob"
    Console.WriteLine(p.Name)
}
main()`
        let output = RunSubmission(source)
        Assert.Contains("Alice", output)
        Assert.DoesNotContain("Bob", output)
    }

    @Fact
    func Map_IndexerLHS_WritesWhenNil() {
        let source = `func main() {
    var m = map[string,string?]{}
    m["k"] = nil
    m["k"] ??= "v"
    Console.WriteLine(m["k"])
    m["k"] ??= "ignored"
    Console.WriteLine(m["k"])
}
main()`
        let output = RunSubmission(source)
        Assert.Contains("v", output)
        Assert.DoesNotContain("ignored", output)
    }

    @Fact
    func Receiver_EvaluatedOnce_RhsOnlyWhenNil() {
        let source = `class Box {
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
main()`
        let output = RunSubmission(source)
        // First call: receiver=1, rhs=1, b.Name=v.
        // Second call: receiver=2 (receiver called again),
        //              rhs still 1 (short-circuited because b.Name not nil),
        //              b.Name still v.
        let lines = output
            .ReplaceLineEndings(Environment.NewLine)
            .TrimEnd(Environment.NewLine.ToCharArray())
            .Split(Environment.NewLine)
        Assert.Equal("1", lines[0])
        Assert.Equal("1", lines[1])
        Assert.Equal("v", lines[2])
        Assert.Equal("2", lines[3])
        Assert.Equal("1", lines[4])
        Assert.Equal("v", lines[5])
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
