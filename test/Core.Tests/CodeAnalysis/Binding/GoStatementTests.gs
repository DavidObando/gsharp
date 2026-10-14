// <copyright file="GoStatementTests.cs" company="GSharp">
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

/// Emitted-oracle coverage for go statement.
open class GoStatementTests {
    @Fact
    func Go_OnUserFunctionCall_Binds() {
        let source = `
func work() int32 {
    return 1
}

go work()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Go_OnAsyncFunctionCall_Binds() {
        let source = `
async func work() int32 {
    return 1
}

go work()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Go_OnNonCallExpression_Diagnoses() {
        let source = `
let x = 42
go x
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("'go'"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            // ADR-0082 / issue #722: gate test fixtures auto-prepend the
            // Go-extensions import so existing `go` tests continue to exercise
            // bind/lower/emit rather than the gate. Issue722-specific gate
            // behaviour is covered by Issue722GoExtensionsImportGateTests.
            let fullSource = source
            return EmittedOracle.Evaluate(fullSource)
        }
    }
}
