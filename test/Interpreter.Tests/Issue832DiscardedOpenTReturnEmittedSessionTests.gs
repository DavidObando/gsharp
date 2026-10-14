// <copyright file="Issue832DiscardedOpenTReturnEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #832: Emitted-session coverage for discarded open t return.
/// Traceability: issues #798 and #813.
open class Issue832DiscardedOpenTReturnEmittedSessionTests {
    @Fact
    func DiscardedDequeue_ClosedQueueOfString_ExecutesSideEffect() {
        // `Queue[string]::Dequeue()` is called in expression-statement
        // position. The emitted session must dispatch the call, remove the
        // front element, and discard the returned value without surfacing a
        // binding error or runtime exception.
        let source = `import System
import System.Collections.Generic

var q = Queue[string]()
q.Enqueue("a")
q.Enqueue("b")
q.Enqueue("c")
q.Dequeue()
Console.WriteLine(q.Count)
Console.WriteLine(q.Peek())`
        Assert.Equal("2${Environment.NewLine}b${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func DiscardedDequeue_ClosedQueueOfInt32_ExecutesSideEffect() {
        // Same shape but with a value-type element. Emission routes through
        // the `unbox.any` guard, and the discard must compose with subsequent
        // state checks.
        let source = `import System
import System.Collections.Generic

var q = Queue[int32]()
q.Enqueue(10)
q.Enqueue(20)
q.Enqueue(30)
q.Dequeue()
q.Dequeue()
Console.WriteLine(q.Count)
Console.WriteLine(q.Peek())`
        Assert.Equal("1${Environment.NewLine}30${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func DiscardedPop_ClosedStackOfInt32_ExecutesSideEffect() {
        // Cross-check the discard works for a different BCL
        // container method (`Stack[T]::Pop()` also returns `T`).
        let source = `import System
import System.Collections.Generic

var s = Stack[int32]()
s.Push(1)
s.Push(2)
s.Push(3)
s.Pop()
Console.WriteLine(s.Count)
Console.WriteLine(s.Peek())`
        Assert.Equal("2${Environment.NewLine}2${Environment.NewLine}", RunSubmission(source))
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
