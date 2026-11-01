// <copyright file="Issue2943LoopBackEdgeNarrowingEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2943: Emitted-oracle coverage for loop back edge narrowing.
open class Issue2943LoopBackEdgeNarrowingEmittedOracleTests {
    @Theory
    @InlineData("function")
    @InlineData("top-level")
    func AssignmentAfterUse_ReportsNullableReceiver($scope string) {
        const Declarations = `class C {
    func Print() { }
}`
        const Body = `var c C? = C()
if c != nil {
    for var i = 0; i < 2; i++ {
        c.Print()
        c = nil
    }
}`
        let source = if $scope == "top-level" {
            Declarations + Environment.NewLine + Body
        } else {
            Declarations + Environment.NewLine + (`
func run() {
` + "${Indent(Body)}" + `
}

run()`)
        }
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0159"
        )
    }

    @Theory
    @InlineData("constructor", "c = C(33)", "function")
    @InlineData("local", "c = fresh", "function")
    @InlineData("function", "c = Mk(33)", "function")
    @InlineData("constructor", "c = C(33)", "top-level")
    @InlineData("local", "c = fresh", "top-level")
    @InlineData("function", "c = Mk(33)", "top-level")
    func NonNullAssignmentAfterUse_PreservesInheritedNarrowing(
        shape string,
        secondIterationAssignment string,
        $scope string
    ) {
        const Declarations = `class C {
    let Value int32

    init(value int32) {
        Value = value
    }
}

func Mk(value int32) C {
    return C(value)
}`
        let body = (`var c C? = C(11)
let fresh C = C(33)
var sum = 0
if c != nil {
    for var i = 0; i < 3; i++ {
        sum = sum + c.Value
        if i == 0 {
            c = C(22)
        }
        if i == 1 {
            ` + "$secondIterationAssignment" + `
        }
    }
}`)
        let source = if $scope == "top-level" {
            Declarations + Environment.NewLine + body + Environment.NewLine + "sum"
        } else {
            Declarations + Environment.NewLine + (`func run() int32 {
` + "${Indent(body)}" + `
    return sum
}

run()`)
        }
        let result = EmittedOracle.Evaluate(source)
        // ADR-0213: a variable or a call is no proof across the back edge (R7 b), and a member read in a loop
        // removes the fact of a mutable top-level variable (R7 e). Only a construction in a function keeps it.
        if shape == "constructor" && $scope == "function" {
            Assert.True(
                result.Diagnostics.IsEmpty,
                "$shape/$$scope: ${string.Join(Environment.NewLine, result.Diagnostics)}"
            )
            Assert.Equal(66, result.Value)
        } else {
            // The rejection is the narrowing error at the `c.Value` read of the loop body, and nothing else.
            let errors = result.Diagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
            Assert.True(errors.Length > 0, "$shape/$$scope must be rejected")
            for error in errors {
                Assert.Equal("GS0158", error.Id)
                Assert.Contains("Value", error.Message)
            }
        }
    }

    @Fact
    func LoopConditionReestablishesNarrowing() {
        const Source = `class C {
    func M() { }
}

func run() int32 {
    var c C? = C()
    var count = 0
    while c != nil {
        c.M()
        count++
        c = nil
    }
    return count
}

run()`
        let result = EmittedOracle.Evaluate(Source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    shared {
        private func Indent(source string) string -> "    " + source.Replace(
            Environment.NewLine,
            Environment.NewLine + "    ",
            StringComparison.Ordinal
        )
    }
}
