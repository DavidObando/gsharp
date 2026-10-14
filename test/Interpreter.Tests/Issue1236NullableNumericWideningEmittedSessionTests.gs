// <copyright file="Issue1236NullableNumericWideningEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #1236: Emitted-session coverage for nullable numeric widening.
open class Issue1236NullableNumericWideningEmittedSessionTests {
    @Fact
    func LiftedLiteralEquality_Present_IsTrue() {
        let source = `let v uint8 = 11
let b uint8? = v
Console.WriteLine((b == 11).ToString())`
        Assert.Equal("True${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func LiftedLiteralEquality_Nil_IsFalse() {
        let source = "let b uint8? = nil\nConsole.WriteLine((b == 11).ToString())"
        Assert.Equal("False${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func LiftedDirectionalWideningEquality_Present_IsTrue() {
        let source = `let av uint8 = 3
let a uint8? = av
let bv int32 = 3
let b int32? = bv
Console.WriteLine((a == b).ToString())`
        Assert.Equal("True${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func LiftedDirectionalWideningEquality_NilOperand_IsFalse() {
        let source = `let av uint8 = 3
let a uint8? = av
let b int32? = nil
Console.WriteLine((a == b).ToString())`
        Assert.Equal("False${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func LiftedArithmeticWidening_Present_AddsThroughUnderlying() {
        let source = `let av int64 = 5
let a int64? = av
let bv int32 = 11
let b int32? = bv
Console.WriteLine((a + b).ToString())`
        Assert.Equal("16${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func LiftedArithmeticWidening_NilOperand_PropagatesNull() {
        let source = `let av int64 = 5
let a int64? = av
let b int32? = nil
Console.WriteLine(((a + b) == nil).ToString())`
        Assert.Equal("True${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func LiftedLiteralArithmetic_AdaptsLiteralToUnderlying() {
        let source = `let v int64 = 5
let b int64? = v
Console.WriteLine((b + 11).ToString())`
        Assert.Equal("16${Environment.NewLine}", RunSubmission(source))
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
