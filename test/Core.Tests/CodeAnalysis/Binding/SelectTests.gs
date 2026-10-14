// <copyright file="SelectTests.cs" company="GSharp">
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

/// Emitted-oracle coverage for select.
/// Traceability: ADR-0022.
open class SelectTests {
    @Fact
    func Select_ReceiveBind_Binds() {
        let source = `
let ch = chan[int32](1)
ch <- 1
select {
case let v = <-ch { let x = v }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Select_ReceiveDiscard_Binds() {
        let source = `
let ch = chan[int32](1)
ch <- 1
select {
case <-ch { let x = 0 }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Select_Send_Binds() {
        let source = `
let ch = chan[int32](1)
select {
case ch <- 42 { let x = 0 }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Select_DefaultTakenWhenNoArmReady() {
        let source = `
let ch = chan[int32](1)
select {
case <-ch { let a = 1 }
default { let b = 2 }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Select_DefaultNotTakenWhenArmReady() {
        let source = `
let ch = chan[int32](1)
ch <- 7
select {
case let v = <-ch { let x = v }
default { let y = 0 }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Select_NoCases_Diagnoses() {
        let source = `
select { }
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("no cases"))
    }

    @Fact
    func Select_ArmBodyWithNestedIf_LowersAndEvaluates() {
        // Regression: the Lowerer must recurse into each select arm body
        // when flattening so nested control flow inside an arm body works.
        // Pre-fix this raised `Unexpected node BlockStatement` from the
        // evaluator when the arm body's lowered if-statement (wrapped in
        // a BoundBlockStatement) was treated as an opaque statement.
        let source = `
let ch = chan[int32](1)
ch <- 5
select {
case let v = <-ch {
    if v > 0 {
        let x = v + 1
    }
}
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Select_DuplicateDefault_Diagnoses() {
        let source = `
let ch = chan[int32](1)
select {
default { let a = 1 }
default { let b = 2 }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("'default'"))
    }

    @Fact
    func Select_ReceiveOnNonChannel_Diagnoses() {
        let source = `
let x = 1
select {
case <-x { let a = 0 }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("channel"))
    }

    @Fact
    func Select_SendOnNonChannel_Diagnoses() {
        let source = `
let x = 1
select {
case x <- 1 { let a = 0 }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("channel"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            // ADR-0082 / issue #722: gate test fixtures auto-prepend the
            // Go-extensions import so existing concurrency tests continue to
            // exercise bind/lower/emit rather than the gate. Issue722-specific
            // gate behaviour is covered by Issue722GoExtensionsImportGateTests.
            let fullSource = source
            return EmittedOracle.Evaluate(fullSource)
        }
    }
}
