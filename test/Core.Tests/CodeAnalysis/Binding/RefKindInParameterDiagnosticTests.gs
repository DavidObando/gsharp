// <copyright file="RefKindInParameterDiagnosticTests.cs" company="GSharp">
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

/// ADR-0060 item #6: body-side enforcement that an `in` parameter
/// cannot be assigned or have its address taken — diagnostics fire as
/// GS0237 with ADR-specific wording (not the generic GS0028 / GS9005).
open class RefKindInParameterDiagnosticTests {
    @Fact
    func InParameterDirectAssignment_ReportsGS0237() {
        const Source = `package InAssign

func bad(in x int32) {
    x = 5
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0237")
    }

    @Fact
    func InParameterAddressOf_ReportsGS0237() {
        const Source = `package InAddrOf

func bad(in x int32) {
    let p = &x
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0237")
    }

    @Fact
    func RefParameterAssignment_DoesNotReportGS0237() {
        const Source = `package RefAssign

func ok(ref x int32) {
    x = 5
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0237")
    }

    @Fact
    func InParameterRead_IsAllowed() {
        const Source = `package InRead

func ok(in x int32) int32 {
    return x + 1
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0237")
    }

    shared {
        private func Compile(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
