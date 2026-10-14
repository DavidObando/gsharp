// <copyright file="Issue752ElvisNullableValueTypeEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #752: Emitted-session coverage for elvis nullable value type.
/// Traceability: ADR-0084.
open class Issue752ElvisNullableValueTypeEmittedSessionTests {
    @Fact
    func Elvis_NullableInt_LeftNil_ReturnsRightUnderlying() {
        let source = `let v int32? = nil
let n = v ?? 0
Console.WriteLine(n)`
        Assert.Equal("0${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Elvis_NullableInt_LeftPresent_ReturnsLeftUnderlying() {
        let source = `let v int32? = 42
let n = v ?? 0
Console.WriteLine(n)`
        Assert.Equal("42${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Elvis_NullableInt_Nested_MiddleHasValue_ChainsThroughInner() {
        let source = `let a int32? = nil
let b int32? = 7
let n = (a ?? b) ?? 0
Console.WriteLine(n)`
        Assert.Equal("7${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Elvis_NullableInt_Nested_AllNil_FallsThroughToLiteral() {
        let source = `let a int32? = nil
let b int32? = nil
let n = (a ?? b) ?? 0
Console.WriteLine(n)`
        Assert.Equal("0${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Elvis_NullableInt_BothArmsNullable_PreservesWrapperShape() {
        let source = `let a int32? = nil
let b int32? = 99
let r int32? = a ?? b
Console.WriteLine(r!!)`
        Assert.Equal("99${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Elvis_ReferenceTypeString_RegressionGuard() {
        let source = `let s string? = nil
let r string = s ?? "missing"
Console.WriteLine(r)

let t string? = "hello"
let u string = t ?? "missing"
Console.WriteLine(u)`
        Assert.Equal("missing${Environment.NewLine}hello${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Elvis_NullableInt_ReceiverOfInstanceCall_RunsInEmittedSession() {
        let source = `let v int32? = 42
Console.WriteLine((v ?? -1).ToString())

let w int32? = nil
Console.WriteLine((w ?? -1).ToString())`
        Assert.Equal("42${Environment.NewLine}-1${Environment.NewLine}", RunSubmission(source))
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
