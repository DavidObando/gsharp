// <copyright file="Issue2965ChannelElementSlotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #2965: Emitted-session coverage for channel element slot.
open class Issue2965ChannelElementSlotTests {
    @Fact
    func UserStructChannelsRemainCorrectInEmittedSession() {
        const Source = `import System

data struct Pair(Value int32)

let plain = chan[Pair](1)
plain <- Pair(41)
Console.WriteLine((<-plain).Value)

let selected = chan[Pair](1)
select {
    case selected <- Pair(42) {
        Console.Write("")
    }
}
select {
    case let value = <-selected { Console.WriteLine(value.Value) }
}`
        Assert.Equal("41${Environment.NewLine}42${Environment.NewLine}", RunSubmission(Source))
    }

    shared {
        private func RunSubmission(source string) string {
            using let output = StringWriter()
            let previousOut = Console.Out
            Console.SetOut(output)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(source)
            } finally {
                Console.SetOut(previousOut)
            }
            return output.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
