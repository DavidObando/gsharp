// <copyright file="EventEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Emitted-session coverage for event.
/// Traceability: ADR-0052.
open class EventEmittedSessionTests {
    @Fact
    func FieldLikeEvent_ParsesWithoutError() {
        let source = `import System
class Foo {
  public event Click func()
}
`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func FieldLikeEvent_OnClass_WithEventArgs() {
        let source = `import System
class MyBtn {
  public event Click func(Object, EventArgs)
}
`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func MultipleEvents_ParseWithoutError() {
        let source = `import System
class Foo {
  public event A func()
  public event B func(int32)
}
`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func InterfaceEvent_ParsesWithoutError() {
        let source = `interface INotify {
  event Changed func()
}
`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
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
