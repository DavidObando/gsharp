// <copyright file="Issue948FieldInitializerBindingTests.cs" company="GSharp">
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

/// Issue #948: binder tests for inline `const`/`let`/`var` field initializers in
/// a type body — constant folding for `const`, and the constraints that a
/// `const` field needs a constant initializer and that an instance initializer
/// cannot reference instance members or constructor parameters.
open class Issue948FieldInitializerBindingTests {
    @Fact
    func ConstField_WithConstantInitializer_NoDiagnostics() {
        const source = `package P
class K {
  const Max int32 = 5 * 10
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0375" || d.Id == "GS0376")
    }

    @Fact
    func ConstField_WithoutInitializer_ReportsGS0375() {
        const source = `package P
class K {
  const Max int32
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0375")
    }

    @Fact
    func ConstField_WithNonConstantInitializer_ReportsGS0376() {
        const source = `package P
class K {
  const Len int32 = "abc".Length
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0376")
    }

    @Fact
    func InstanceInitializer_ReferencingInstanceMember_ReportsGS0377() {
        const source = `package P
class Foo {
  var a int32 = 5
  var b int32 = a + 10
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func InstanceInitializer_ReferencingThis_ReportsGS0377() {
        const source = `package P
class Foo {
  var a int32 = 5
  var b int32 = this.a
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func InstanceInitializer_WithConstantExpression_NoGS0377() {
        const source = `package P
class Foo {
  var a int32 = 5
  var b int32 = 10
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }
    }
}
