// <copyright file="Issue1172ArrowLambdaParityBinderTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// ADR-0128 / issue #1172 — a block-bodied arrow lambda `(p) -> { … }` is
/// now a STATEMENT block with an optional trailing value expression, reaching parity
/// with func literals. An `if` WITHOUT a matching `else` inside the block
/// is a void if-STATEMENT (no longer rejected with GS0276 as a value-position
/// if-expression). These binder tests pin the FAILS-today cases (now clean) and the
/// WORKS-today regression guards, plus the distinction that a value-position block
/// (not a lambda body) ending in a void `if` still has no value.
open class Issue1172ArrowLambdaParityBinderTests {
    @Fact
    func NonTrailingIfWithoutElse_VoidStatement_NoGS0276() {
        let result = Evaluate(`
let f = (x int32) -> { if x > 0 { Console.WriteLine("a") }
return x * 2 }
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0276")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TrailingIfWithoutElse_VoidActionLambda_NoGS0276() {
        let result = Evaluate(`
let f = (x int32) -> { if x > 0 { Console.WriteLine("a") } }
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0276")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func EarlyReturnInsideIfWithoutElse_NoGS0276() {
        let result = Evaluate(`
let f = (x int32) -> { if x < 0 { return 0 }
return x * 2 }
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0276")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NonTrailingIfWithoutElse_ThenTrailingValue_NoGS0276() {
        let result = Evaluate(`
let f = (x int32) -> { if x > 0 { Console.WriteLine("p") }
let z = x * 2
z }
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0276")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ExplicitFuncTargetType_IfWithoutElse_NoGS0276() {
        let result = Evaluate(`
let g Func[int32, int32] = (x int32) -> { if x > 0 { return x }
return 0 }
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0276")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NestedIfWithoutElse_InnerIfWithElse_NoGS0276() {
        let result = Evaluate(`
let f = (x int32) -> { if x > 0 { if x > 10 { Console.WriteLine("big") } else { Console.WriteLine("small") } }
x }
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0276")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TrailingIfWithElse_AsValue_StillBindsCleanly() {
        let result = Evaluate(`
let f = (x int32) -> { if x > 0 { "pos" } else if x < 0 { "neg" } else { "zero" } }
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ElseIfChainWithoutFinalElse_VoidStatement_NoGS0276() {
        // An `if`/`else if` chain WITHOUT a terminating plain `else` has a path
        // that yields no value, so it is a void if-STATEMENT (parity with func
        // literals) — not a value-position if-expression rejected with GS0276.
        let result = Evaluate(`
let g = (y int32) -> { if y > 0 { Console.WriteLine("p") } else if y < 0 { Console.WriteLine("n") } }
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0276")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0124")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ElseIfChainTerminatingPlainElse_AsValue_StillBindsCleanly() {
        // An `if`/`else if` chain that DOES terminate in a plain `else` is a
        // value-producing if-expression and must still bind cleanly.
        let result = Evaluate(`
let g = (y int32) -> { if y > 0 { 1 } else if y < 0 { 2 } else { 3 } }
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TrailingExpressionValueBlock_StillBindsCleanly() {
        let result = Evaluate(`
let f = (x int32) -> { let y = x + 1
y * 2 }
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NonTrailingVoidCall_ThenTrailingValue_StillBindsCleanly() {
        let result = Evaluate(`
let f = (x int32) -> { Console.WriteLine("hi")
x * 2 }
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ExplicitReturnOnly_StillBindsCleanly() {
        let result = Evaluate(`
let f = (x int32) -> { return x * 2 }
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func IfExpression_InLetInit_MissingElse_StillReportsGS0276() {
        // Regression guard: an `if` used directly as a value (NOT inside a
        // block-expression item) is still a value-position if-expression and
        // must have an `else`. The parser look-ahead only reclassifies `if`
        // inside a block expression.
        let result = Evaluate(`
let x = if true { 1 }
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0276")
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
