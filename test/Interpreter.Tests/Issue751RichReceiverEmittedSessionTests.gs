// <copyright file="Issue751RichReceiverEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #751: Emitted-session coverage for rich receiver.
/// Traceability: ADR-0084.
open class Issue751RichReceiverEmittedSessionTests {
    @Fact
    func NullableString_Receiver_Dispatches() {
        let source = `func (self string?) OrElse(fb string) string {
    return self ?? fb
}

var present string? = "hi"
var absent string? = nil
Console.WriteLine(present.OrElse("nope"))
Console.WriteLine(absent.OrElse("nope"))`
        Assert.Equal("hi${Environment.NewLine}nope${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Tuple_Receiver_Dispatches() {
        let source = `func (self (int32, string)) Show() string {
    return self.Item1.ToString() + ":" + self.Item2
}

var p = (42, "hi")
Console.WriteLine(p.Show())`
        Assert.Equal("42:hi${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func NullableArray_Receiver_Dispatches() {
        let source = `func (self []?int32) FirstOrZero() int32 {
    if self == nil {
        return 0
    }
    if self.Length == 0 {
        return 0
    }
    return self[0]
}

var present []?int32 = []int32{10, 20}
var absent []?int32 = nil
Console.WriteLine(present.FirstOrZero())
Console.WriteLine(absent.FirstOrZero())`
        Assert.Equal("10${Environment.NewLine}0${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Map_Receiver_Dispatches() {
        let source = `func (self map[string,int32]) CountKeys() int32 {
    return self.Count
}

var m = map[string,int32]{"a": 1, "b": 2, "c": 3}
Console.WriteLine(m.CountKeys())`
        Assert.Equal("3${Environment.NewLine}", RunSubmission(source))
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
            return outWriter.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
