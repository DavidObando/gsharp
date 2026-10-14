// <copyright file="LetFieldBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0067 / issue #694: binder tests for `let` (read-only) fields on
/// user-declared types.
open class LetFieldBindingTests {
    @Fact
    func LetField_ReassignmentReportsCannotAssign() {
        const source = `package P
class Counter {
  let Value int32 = 0
  init() {}
}
var c = Counter()
c.Value = 1
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func VarField_ReassignmentAllowed() {
        const source = `package P
class Counter {
  var Value int32 = 0
  init() {}
}
var c = Counter()
c.Value = 1
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }
    }
}
