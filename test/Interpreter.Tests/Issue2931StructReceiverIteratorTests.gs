// <copyright file="Issue2931StructReceiverIteratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Emitted-session coverage for issue #2931 struct receiver iterators.
open class Issue2931StructReceiverIteratorTests {
    @Fact
    func StructIteratorReceiversUseValueSemantics() {
        const Source = `import System

struct Box {
    var N int32
    func vals() sequence[int32] { yield N }
}

struct Pair {
    var A int32
    var B int32

    func vals() sequence[int32] {
        yield A
        A = A + B
        yield A
        yield B
    }
}

class ClassBox(N int32) {
    func vals() sequence[int32] { yield N }
}

for value in Box{N: 100}.vals() {
    Console.WriteLine(value)
}

var box = Box{N: 110}
for value in box.vals() {
    Console.WriteLine(value)
}

var pair = Pair{A: 160, B: 3}
for value in pair.vals() {
    Console.WriteLine(value)
}
Console.WriteLine(pair.A)

for value in ClassBox(400).vals() {
    Console.WriteLine(value)
}`
        Assert.Equal(
            "100${Environment.NewLine}110${Environment.NewLine}160${Environment.NewLine}163${Environment.NewLine}3${Environment.NewLine}160${Environment.NewLine}400${Environment.NewLine}",
            RunSubmission(Source)
        )
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
