// <copyright file="Issue3067IteratorConstraintRemapEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

@Collection("ConsoleIo")
open class Issue3067IteratorConstraintRemapEmittedOracleTests {
    @Theory
    @InlineData(false, "66")
    @InlineData(true, "77")
    func ConstraintRepro_TopLevelAndInFunction_Runs(inFunction bool, expected string) {
        let source = if inFunction {
            InFunctionSource
        } else {
            TopLevelSource
        }
        let result = EmittedOracle.Evaluate(source)
        Assert.False(
            result.Diagnostics.Any((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError),
            string.Join(Environment.NewLine, result.Diagnostics)
        )
        Assert.Equal(expected + Environment.NewLine, result.Output.ReplaceLineEndings(Environment.NewLine))
    }

    shared {
        private const TopLevelSource string = `package Issue3067.InterpreterTopLevel
import System
open class Box[T any] {}
class IntBox : Box[int32] {}
func Values[T any, TBox Box[T] init()](value T) sequence[T] {
    yield value
}
for value in Values[int32, IntBox](66) {
    Console.WriteLine(value)
}`

        private const InFunctionSource string = `package Issue3067.InterpreterInFunction
import System
open class Box[T any] {}
class IntBox : Box[int32] {}
func Values[T any, TBox Box[T] init()](value T) sequence[T] {
    yield value
}
func Run() {
    for value in Values[int32, IntBox](77) {
        Console.WriteLine(value)
    }
}
Run()`
    }
}
