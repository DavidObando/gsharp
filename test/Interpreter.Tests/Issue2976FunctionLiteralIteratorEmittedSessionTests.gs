// <copyright file="Issue2976FunctionLiteralIteratorEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Issue #2976: Emitted-session coverage for function literal iterator.
class Issue2976FunctionLiteralIteratorEmittedSessionTests {
    @Theory
    @MemberData("Cases")
    func IteratorLiteral_Runs(source string, expectedOutput string) {
        using let writer = StringWriter()
        let previousOut = Console.Out
        Console.SetOut(writer)
        try {
            let repl = GSharpRepl()
            repl.EvaluateSubmission(source)
        } finally {
            Console.SetOut(previousOut)
        }
        Assert.Equal(expectedOutput, writer.ToString().ReplaceLineEndings(Environment.NewLine))
    }

    shared {
        func Cases() sequence[[]object] {
            yield Case(`let values = func() sequence[int32] { yield 2 }
for value in values() {
    Console.WriteLine(value)
}`, "2\n")
            yield Case(`func make(start int32) () -> sequence[int32] {
    return func() sequence[int32] {
        yield start
        Console.WriteLine(start)
        yield start + 1
    }
}

for value in make(4)() {
    Console.WriteLine(value)
}`, `4
4
5
`)
            yield Case(`func make[T any]() (T) -> sequence[T] {
    return func(value T) sequence[T] { yield value }
}

for value in make[string]()("ok") {
    Console.WriteLine(value)
}`, "ok\n")
            yield Case(`func values() sequence[int32] { yield 9 }
for value in values() {
    Console.WriteLine(value)
}`, "9\n")
            yield Case(`func values() sequence[int32] {
    yield 7
    yield 8
}

var getValues () -> sequence[int32] = values
for value in getValues() {
    Console.WriteLine(value)
}`, `7
8
`)
        }

        private func Case(source string, expectedOutput string)[]object -> []object{source, expectedOutput}
    }
}
