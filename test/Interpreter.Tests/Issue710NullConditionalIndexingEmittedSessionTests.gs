// <copyright file="Issue710NullConditionalIndexingEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #710: Emitted-session coverage for null conditional indexing.
/// Traceability: ADR-0073.
open class Issue710NullConditionalIndexingEmittedSessionTests {
    @Fact
    func Slice_NullReceiver_YieldsNil() {
        let source = `var a []?int32 = nil
var x = a?[0]
if x == nil {
    Console.WriteLine("nil")
} else {
    Console.WriteLine("notnil")
}`
        let output = RunSubmission(source)
        Assert.Contains("nil", output)
        Assert.DoesNotContain("notnil", output)
    }

    @Fact
    func Slice_NonNullReceiver_YieldsLiftedValue() {
        let source = `var a []?int32 = []int32{10, 20, 30}
var x = a?[1]
Console.WriteLine(x)`
        let output = RunSubmission(source)
        Assert.Contains("20", output)
    }

    @Fact
    func Map_NullReceiver_YieldsNil() {
        let source = `var d Dictionary[string, int32]? = nil
var v = d?["k"]
if v == nil {
    Console.WriteLine("nil")
} else {
    Console.WriteLine("notnil")
}`
        let output = RunSubmission(source)
        Assert.Contains("nil", output)
        Assert.DoesNotContain("notnil", output)
    }

    @Fact
    func Map_NonNullReceiver_YieldsLiftedValue() {
        let source = `var d Dictionary[string, int32]? = Dictionary[string, int32]()
d.Add("a", 100)
d.Add("b", 200)
var v = d?["a"]
Console.WriteLine(v)`
        let output = RunSubmission(source)
        Assert.Contains("100", output)
    }

    @Fact
    func StringDictionary_ReferenceTypedResult_PropagatesNil() {
        let source = `var d Dictionary[string, string]? = Dictionary[string, string]()
d.Add("hi", "world")
Console.WriteLine(d?["hi"])

var d2 Dictionary[string, string]? = nil
var v = d2?["hi"]
if v == nil {
    Console.WriteLine("nil")
}`
        let output = RunSubmission(source)
        Assert.Contains("world", output)
        Assert.Contains("nil", output)
    }

    @Fact
    func Receiver_EvaluatedOnce_WhenNonNull() {
        // The receiver function is called once per `?[...]` site whether
        // or not it returns nil. The index sub-expression must not be
        // evaluated when the receiver is nil.
        let source = `var receiverCalls int32 = 0
var indexCalls int32 = 0

func getSlice() []?int32 {
    receiverCalls = receiverCalls + 1
    return []int32{7, 8, 9}
}

func getNilSlice() []?int32 {
    receiverCalls = receiverCalls + 1
    return nil
}

func getIndex() int32 {
    indexCalls = indexCalls + 1
    return 1
}

func main() {
    var x = getSlice()?[getIndex()]
    Console.WriteLine(x)
    Console.WriteLine(receiverCalls)
    Console.WriteLine(indexCalls)

    var y = getNilSlice()?[getIndex()]
    if y == nil {
        Console.WriteLine("nil")
    }
    Console.WriteLine(receiverCalls)
    Console.WriteLine(indexCalls)
}

main()`
        let output = RunSubmission(source).ReplaceLineEndings(Environment.NewLine)
        let lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("8", lines[0])
        Assert.Equal("1", lines[1])
        Assert.Equal("1", lines[2])
        Assert.Equal("nil", lines[3])
        Assert.Equal("2", lines[4])
        Assert.Equal("1", lines[5])
    }

    @Fact
    func RangeSlice_ShortCircuitsBounds_WhenReceiverIsNil() {
        let source = `var trace string = ""

func receiver(value string?) string? {
    trace = trace + "R"
    return value
}

func lower() int32 {
    trace = trace + "S"
    return 1
}

func upper() int32 {
    trace = trace + "E"
    return 4
}

var missing = receiver(nil)?[lower()..upper()]
if missing == nil {
    Console.WriteLine("nil")
}
Console.WriteLine(trace)

trace = ""
Console.WriteLine(receiver("abcdef")?[lower()..upper()])
Console.WriteLine(trace)`
        let output = RunSubmission(source).ReplaceLineEndings(Environment.NewLine)
        Assert.Contains(
            "nil${Environment.NewLine}R${Environment.NewLine}bcd${Environment.NewLine}RSE${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Chained_NullConditional_Member_Then_Index() {
        let source = `class Holder {
    var Data []?int32
}

func main() {
    var h Holder? = Holder{Data: []int32{1, 2, 3}}
    var v = h?.Data?[1]
    Console.WriteLine(v)

    var hNoData Holder? = Holder{Data: nil}
    var v2 = hNoData?.Data?[0]
    if v2 == nil {
        Console.WriteLine("nil-data")
    }

    var hNil Holder? = nil
    var v3 = hNil?.Data?[0]
    if v3 == nil {
        Console.WriteLine("nil-holder")
    }
}

main()`
        let output = RunSubmission(source)
        Assert.Contains("2", output)
        Assert.Contains("nil-data", output)
        Assert.Contains("nil-holder", output)
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
