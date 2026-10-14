// <copyright file="Issue2349LambdaIfStatementBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2349 — binder-level coverage for the parser fix in
/// `Issue2349LambdaIfStatementParserTests`: a mid-body if/else
/// (terminated by a plain `else`) inside a lambda block body must bind
/// cleanly as a void if-STATEMENT, without the spurious GS0124 ("Expression
/// must have a value") that resulted from misclassifying it as a
/// value-producing if-EXPRESSION. Covers sync/async lambdas, nested blocks,
/// multiple mid-body if/else constructs, and the exact Oahu.Diagnostics
/// `rootCmd.SetAction` async-lambda shape (two independent mid-body
/// if/else blocks assigning/branching on a result, followed by a final
/// return), plus ordinary-function and tail-if-expression controls.
open class Issue2349LambdaIfStatementBinderTests {
    @Fact
    func MidBodyIfElse_VoidArms_NoGS0124() {
        let result = Evaluate(`
let f = (cond bool) -> {
    if cond {
        Console.WriteLine("a")
    } else {
        Console.WriteLine("b")
    }
    Console.WriteLine("c")
}
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0124")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func MidBodyIfElse_AssignmentArms_NoGS0124() {
        // Exact Oahu shape facet: both arms are assignment statements to an
        // already-declared local, not calls.
        let result = Evaluate(`
let f = (doExport bool) -> {
    var report = ""
    if doExport {
        report = "export"
    } else {
        report = "run"
    }
    Console.WriteLine(report)
}
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0124")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func MidBodyElseIfChain_VoidArms_NoGS0124() {
        let result = Evaluate(`
let f = (n int32) -> {
    if n > 0 {
        Console.WriteLine("p")
    } else if n < 0 {
        Console.WriteLine("n")
    } else {
        Console.WriteLine("z")
    }
    Console.WriteLine("done")
}
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0124")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ExactOahuDiagnosticsShape_TwoMidBodyIfElseBlocks_ThenReturn_NoGS0124() {
        // The exact real-world shape from tools/Oahu.Diagnostics/Program.cs:
        // an async lambda (`rootCmd.SetAction(async (parse, ct) => { ... })`)
        // with two independent mid-body if/else blocks (each assigning a
        // result variable), followed by further statements and a final
        // `return` with an integer value.
        let result = Evaluate(`
let handler = async (doExport bool, useJson bool) -> {
    var report = ""
    if doExport {
        report = "export"
    } else {
        report = "run"
    }

    if useJson {
        Console.WriteLine("json: " + report)
    } else {
        Console.WriteLine("pretty: " + report)
    }

    await Task.CompletedTask
    return 0
}
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0124")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NestedMidBodyIfElse_InsideOuterIfsThenBlock_NoGS0124() {
        let result = Evaluate(`
let f = (a bool, b bool) -> {
    if a {
        if b {
            Console.WriteLine("ab")
        } else {
            Console.WriteLine("a")
        }
        Console.WriteLine("after-inner")
    } else {
        Console.WriteLine("none")
    }
    Console.WriteLine("done")
}
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0124")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func AsyncLambda_MidBodyIfElse_NoGS0124() {
        let result = Evaluate(`
let f = async (ok bool) -> {
    if ok {
        Console.WriteLine("y")
    } else {
        Console.WriteLine("n")
    }
    await Task.CompletedTask
}
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0124")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func SingleIdentifierArrowLambda_MidBodyIfElse_NoGS0124() {
        // Issue #932 single-identifier arrow-lambda shorthand `x -> { ... }`
        // shares the same block-expression parse path. A target type is
        // needed for the parameter to infer its type.
        let result = Evaluate(`
let f Action[bool] = cond -> {
    if cond {
        Console.WriteLine("y")
    } else {
        Console.WriteLine("n")
    }
    Console.WriteLine("done")
}
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0124")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TailIfElse_StillValueProducing_ControlUnaffected() {
        // Control: a tail-position if/else (last item of the block) is still
        // a value-producing if-expression, unaffected by the fix.
        let result = Evaluate(`
let f = (cond bool) -> {
    if cond { 1 } else { 2 }
}
Console.WriteLine(f(true))
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func OrdinaryFunction_MidBodyIfElse_ControlAlreadyWorks() {
        // Control: ordinary (non-lambda) functions parse their bodies via
        // ParseBlockStatement, never the block-expression if-expression
        // heuristic — mid-body if/else already worked there before this fix
        // and must continue to.
        let result = Evaluate(`
func F(cond bool) {
    if cond {
        Console.WriteLine("a")
    } else {
        Console.WriteLine("b")
    }
    Console.WriteLine("c")
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func LocalFunction_MidBodyIfElse_ControlAlreadyWorks() {
        // Control: a "local function" in G# is a lambda bound to a `let`
        // inside another function's body (no separate declaration syntax).
        // It shares the exact same block-expression parse path as any other
        // lambda and must be fixed identically.
        let result = Evaluate(`
func Outer(cond bool) {
    let Inner = (c bool) -> {
        if c {
            Console.WriteLine("a")
        } else {
            Console.WriteLine("b")
        }
        Console.WriteLine("c")
    }
    Inner(cond)
}
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0124")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func MidBodyIfWithoutElse_StillWorks_Regression() {
        // Regression guard: an if/else-if chain WITHOUT a terminating plain
        // else was already a void if-statement regardless of position
        // (issue #1172) — must remain unaffected.
        let result = Evaluate(`
let f = () -> {
    if true {
        Console.WriteLine("a")
    }
    Console.WriteLine("b")
}
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0124")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0276")
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            let prelude = `import System
import System.Threading.Tasks
`
            return EmittedOracle.Evaluate(prelude + source)
        }
    }
}
