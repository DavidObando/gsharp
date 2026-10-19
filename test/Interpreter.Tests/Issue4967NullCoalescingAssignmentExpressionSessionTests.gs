// <copyright file="Issue4967NullCoalescingAssignmentExpressionSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import GSharp.Repl.Engine
import System
import System.IO
import Xunit

/// Issue #4967: the REPL evaluates `??=` in value position — the value is
/// the target's final value and the right side runs only when it is nil.
open class Issue4967NullCoalescingAssignmentExpressionSessionTests {
    @Theory
    @InlineData("=")
    @InlineData("??=")
    func TupleElementProperty_CrossSubmissionWritesStoredValue(op string) {
        using let engine = EmittedSessionEngine()
        let declaration = engine.Evaluate(`import System.Collections
var tuple = System.ValueTuple[DictionaryEntry, int32](DictionaryEntry("key", nil), 0)`)
        Assert.False(declaration.HasError, string.Join("; ", declaration.Diagnostics))
        let assignment = engine.Evaluate(`tuple.Item1.Value OP "v"`.Replace("OP", op))
        Assert.False(assignment.HasError, string.Join("; ", assignment.Diagnostics))
        let probe = engine.Evaluate("tuple.Item1.Value")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal("v", probe.Value)
    }

    @Fact
    func ReadOnlyTupleElementProperty_CrossSubmissionWriteIsRejected() {
        using let engine = EmittedSessionEngine()
        let declaration = engine.Evaluate(`import System.Collections
let tuple = System.ValueTuple[DictionaryEntry, int32](DictionaryEntry("key", nil), 0)`)
        Assert.False(declaration.HasError, string.Join("; ", declaration.Diagnostics))
        let assignment = engine.Evaluate(`tuple.Item1.Value = "v"`)
        Assert.True(assignment.HasError)
        Assert.Contains(
            assignment.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0127"
        )
    }

    @Fact
    func ValuePosition_YieldsFinalValue_RhsOnlyWhenNil() {
        let source = `var log = ""
func v(s string) string {
    log += s
    return s
}
var t string? = nil
let first = (t ??= v("one"))
let second = (t ??= v("two"))
var n int32? = nil
let k int32 = (n ??= 42)
Console.WriteLine("result=" + first + "," + second + "," + log + "," + "$k")`
        let output = RunSubmission(source)
        Assert.Contains("result=one,one,one,42", output)
    }

    @Fact
    func StructReceivers_WriteArrayElementsAndNestedFieldsInPlace() {
        let source = `struct S {
    var F string?
}
struct Outer {
    var Inner S
}
class Holder {
    var O Outer
}
var a = []S{S{}}
let value = (a[0].F ??= "array")
let h = Holder{}
h.O.Inner.F ??= "nested"
Console.WriteLine("storage=" + value + "," + (a[0].F ?? "nil") + "," + (h.O.Inner.F ?? "nil"))`
        Assert.Contains("storage=array,array,nested", RunSubmission(source))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StructReceivers_CrossSubmissionClrField_KeepsItsStorage(valuePosition bool) {
        using let engine = EmittedSessionEngine()
        let declaration = engine.Evaluate(`import System.Collections
import System.Runtime.CompilerServices
var box = StrongBox[DictionaryEntry](DictionaryEntry("key", nil))`)
        Assert.False(declaration.HasError, string.Join("; ", declaration.Diagnostics))
        let assignment = engine.Evaluate(
            if valuePosition {
                `(box.Value.Value ??= "v")`
            } else {
                `box.Value.Value ??= "v"`
            }
        )
        Assert.False(assignment.HasError, string.Join("; ", assignment.Diagnostics))
        if valuePosition {
            Assert.Equal("v", assignment.Value)
        }
        let probe = engine.Evaluate("box.Value.Value")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal("v", probe.Value)
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
