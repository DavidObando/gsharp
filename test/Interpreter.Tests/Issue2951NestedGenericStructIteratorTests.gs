// <copyright file="Issue2951NestedGenericStructIteratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Emitted-session coverage for issue #2951 nested generic struct iterators.
open class Issue2951NestedGenericStructIteratorTests {
    @Fact
    func NestedStructIteratorUsesEnclosingTypeParameter() {
        const Source = `import System

class Wrap[T] {
    struct Cell {
        var A T
        func vals() sequence[T] { yield A }
    }
}

for value in Wrap[int32].Cell{A: 42}.vals() {
    Console.WriteLine(value)
}`
        Assert.Equal("42${Environment.NewLine}", RunSubmission(Source))
    }

    @Fact
    func NestedGenericStructIteratorUsesEnclosingAndOwnTypeParameters() {
        const Source = `import System

class Outer[T] {
    struct Cell[U] {
        var A T
        var B U
        func vals() sequence[string] { yield A.ToString() + B.ToString() }
    }
}

var first = Outer[int32].Cell[string]{A: 42, B: "x"}
for value in first.vals() {
    Console.WriteLine(value)
}

var second = Outer[string].Cell[int32]{A: "y", B: 7}
for value in second.vals() {
    Console.WriteLine(value)
}`
        Assert.Equal("42x${Environment.NewLine}y7${Environment.NewLine}", RunSubmission(Source))
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
