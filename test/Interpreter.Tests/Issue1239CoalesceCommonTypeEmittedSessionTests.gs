// <copyright file="Issue1239CoalesceCommonTypeEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #1239: Emitted-session coverage for coalesce common type.
open class Issue1239CoalesceCommonTypeEmittedSessionTests {
    @Fact
    func NumericWidening_RightWidensToLeftUnderlying_LeftPresent() {
        let source = `let a int32? = 100
let b uint16 = 7
Console.WriteLine((a ?? b).ToString())`
        Assert.Equal("100${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func NumericWidening_RightWidensToLeftUnderlying_LeftNil() {
        let source = `let a int32? = nil
let b uint16 = 7
Console.WriteLine((a ?? b).ToString())`
        Assert.Equal("7${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func NumericWidening_LeftWidensToRight_LeftPresent_ConvertsToResultType() {
        let source = `let a int32? = 100
let b int64 = 9000000000
Console.WriteLine((a ?? b).ToString())`
        Assert.Equal("100${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func NumericWidening_LeftWidensToRight_LeftNil() {
        let source = `let a int32? = nil
let b int64 = 9000000000
Console.WriteLine((a ?? b).ToString())`
        Assert.Equal("9000000000${Environment.NewLine}", RunSubmission(source))
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
