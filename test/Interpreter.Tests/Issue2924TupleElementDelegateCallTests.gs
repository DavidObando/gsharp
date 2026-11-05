// <copyright file="Issue2924TupleElementDelegateCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #2924 emitted-session coverage for shared numeric tuple-selector
/// syntax, binding, and delegate invocation behavior.
open class Issue2924TupleElementDelegateCallTests {
    @Fact
    func NumericSelectors_ReadHigherAndNestedElements() {
        let output = RunSubmission(`let t = ((10, 20), 30)
let selected = t.0.1
Console.WriteLine(selected)`)
        Assert.Equal("20${Environment.NewLine}", output)
    }

    @Fact
    func NullConditionalNumericSelector_ReadsElement() {
        let output = RunSubmission(`let t (int32, int32)? = (41, 0)
let selected = t?.0
Console.WriteLine(selected)`)
        Assert.Equal("41${Environment.NewLine}", output)
    }

    @Fact
    func NumericSelectorValue_FlowsThroughAssignmentAndArgument() {
        let output = RunSubmission(`func Show(value int32) {
    Console.WriteLine(value)
}
let t = (41, 0)
let selected int32 = t.0
Show(t.0)`)
        Assert.Equal("41${Environment.NewLine}", output)
    }

    @Fact
    func FunctionReturnedTuple_NumericSelectorReadsElement() {
        let output = RunSubmission(`func Make() (int32, int32) {
    return (41, 0)
}
Console.WriteLine(Make().0)`)
        Assert.Equal("41${Environment.NewLine}", output)
    }

    @Fact
    func StructTupleField_NumericSelectorReadsElement() {
        let output = RunSubmission(`data struct Holder(Value (int32, int32))
let holder = Holder((41, 0))
Console.WriteLine(holder.Value.0)`)
        Assert.Equal("41${Environment.NewLine}", output)
    }

    @Fact
    func CurriedMemberCall_InvokesReceiverWideCallee() {
        let output = RunSubmission(`class Factory {
    func Make() (int32) -> int32 {
        return (value int32) -> value + 1
    }
}
let factory = Factory()
Console.WriteLine(factory.Make()(41))`)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func TupleHeldFunction_NumericSelectorInvokesCallable() {
        let output = RunSubmission(
            "let functions = ((value int32) -> value + 1, 0)\nConsole.WriteLine(functions.0(41))"
        )
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func NullConditionalCurriedMemberCall_InvokesNonNilReceiver() {
        let output = RunSubmission(`class Factory {
    func Make(seed int32) (int32) -> int32 {
        return (value int32) -> seed + value
    }
}
let factory = Factory()
Console.WriteLine(factory?.Make(40)(2))`)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func NullConditionalCurriedMemberCall_ShortCircuitsNilReceiver() {
        let output = RunSubmission(`class Factory {
    func Make(seed int32) (int32) -> int32 {
        return (value int32) -> seed + value
    }
}
let factory Factory? = nil
factory?.Make(40)(2)
Console.WriteLine("end")`)
        Assert.Equal("end${Environment.NewLine}", output)
    }

    @Fact
    func NullConditionalNumericSelectorCall_ShortCircuitsNilTuple() {
        let output = RunSubmission(`let t (System.Func[int32, int32], int32)? = nil
t?.0(1)
Console.WriteLine("end")`)
        Assert.Equal("end${Environment.NewLine}", output)
    }

    @Fact
    func NullConditionalAssertedCall_InvokesAndShortCircuits() {
        let output = RunSubmission(`class Factory {
    func Make(seed int32) (int32) -> int32 {
        return (value int32) -> seed + value
    }
}
let live = Factory()
Console.WriteLine(live?.Make(40)!!(2))
let missing Factory? = nil
missing?.Make(40)!!(2)
Console.WriteLine("end")`)
        // Issue #3501: the `!!!!` double-assertion variants moved out of this
        // output-comparing harness — the second assertion is redundant by
        // construction and now draws GS0536 into the compared stream. Chain
        // coverage lives in the Core.Tests/Compiler.Tests Issue2924 twins.
        Assert.Equal("42${Environment.NewLine}end${Environment.NewLine}", output)
    }

    @Fact
    func NumericSelectorAssignments_WriteTupleElement() {
        let output = RunSubmission(`var assigned = (1, 2)
assigned.0 = 5
Console.WriteLine(assigned.0)

var compounded = (1, 2)
compounded.0 += 6
Console.WriteLine(compounded.0)`)
        Assert.Equal("5${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func NonCallableTupleElement_ReportsNotAFunction() {
        let output = RunSubmission("let t = (41, 0)\nt.0(1)")
        Assert.Contains("GS0131", output)
    }

    @Fact
    func NilTupleElementDelegate_ReportsRuntimeFailure() {
        let output = RunSubmission(`let handler System.Action[int32] = default(System.Action[int32])
let t = (handler, 0)
t.0(1)`)
        // Emitted execution surfaces the nil-delegate invocation as the real
        // CLR NullReferenceException (the evaluator's reflection-invoke
        // "Non-static method requires a target." message retired with it,
        // ADR-0156 Phase 3c, #3176).
        Assert.Contains("NullReferenceException", output)
    }

    @Fact
    func OutOfRangeNumericSelector_ReportsMissingMember() {
        let output = RunSubmission("let t = (41, 0)\nt.2")
        Assert.Contains("GS0158", output)
    }

    @Fact
    func ItemNameSelector_RemainsSupported() {
        let output = RunSubmission("let t = (41, 0)\nConsole.WriteLine(t.Item1)")
        Assert.Equal("41${Environment.NewLine}", output)
    }

    @Fact
    func LeadingDotFloat_RemainsLiteralInPrimaryPosition() {
        let output = RunSubmission("Console.WriteLine(.5 + .25)")
        Assert.Equal("0.75${Environment.NewLine}", output)
    }

    shared {
        private func RunSubmission(text string) string {
            using let output = StringWriter()
            let previousOut = Console.Out
            Console.SetOut(output)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(previousOut)
            }
            return output.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
