// <copyright file="RefKindEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Emitted-session coverage for ref kind.
/// Traceability: ADR-0060; issue #7.
open class RefKindEmittedSessionTests {
    @Fact
    func RefParameter_CallerObservesMutation() {
        let output = RunSubmission(`
func bump(ref counter int32, by int32) {
    counter = counter + by
}

var c = 10
bump(&c, 5)
Console.WriteLine(c)
`)
        Assert.Contains("15", output)
    }

    @Fact
    func OutParameter_CallerReceivesAssignedValue() {
        let output = RunSubmission(`
func tryProduce(out result int32) bool {
    result = 42
    return true
}

var v = 0
let ok = tryProduce(&v)
Console.WriteLine(v)
`)
        Assert.Contains("42", output)
    }

    @Fact
    func OutParameter_UserFunctionCanReadCallerValueBeforeAssignment() {
        let output = RunSubmission(`import System

func addOne(out result int32) {
    result = result + 1
}

var value = 41
addOne(&value)
Console.WriteLine(value)`)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func ClrMethod_InlineOutVar_ProducesValue() {
        let output = RunSubmission(`import System

int32.TryParse("77", out var parsed)
Console.WriteLine(parsed)`)
        Assert.Equal("77${Environment.NewLine}", output)
    }

    @Fact
    func UserFunction_InlineOutVar_ProducesValue() {
        let output = RunSubmission(`import System

func tryProduce(out result int32) bool {
    result = 22
    return true
}

tryProduce(out var produced)
Console.WriteLine(produced)`)
        Assert.Equal("22${Environment.NewLine}", output)
    }

    @Fact
    func UserFunction_InlineOutLet_ProducesValue() {
        let output = RunSubmission(`import System

func tryProduce(out result int32) bool {
    result = 33
    return true
}

tryProduce(out let produced)
Console.WriteLine(produced)`)
        Assert.Equal("33${Environment.NewLine}", output)
    }

    @Fact
    func UserFunction_OutDiscard_ExecutesCallee() {
        let output = RunSubmission(`import System

func produce(out result int32) int32 {
    result = 44
    return result
}

let observed = produce(out _)
Console.WriteLine(observed)`)
        Assert.Equal("44${Environment.NewLine}", output)
    }

    @Fact
    func InParameter_BodyReadsCallerValue() {
        let output = RunSubmission(`
func sum(in x int32, in y int32) int32 {
    return x + y
}

var a = 7
var b = 35
Console.WriteLine(sum(&a, &b))
`)
        Assert.Contains("42", output)
    }

    @Fact
    func InParameter_CallerValueIsUnchanged() {
        let output = RunSubmission(`
func observe(in v int32) {
    Console.WriteLine(v)
}

var x = 12
observe(&x)
Console.WriteLine(x)
`)
        Assert.Contains("12", output)
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
