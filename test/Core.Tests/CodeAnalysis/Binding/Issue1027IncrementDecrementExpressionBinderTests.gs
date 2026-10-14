// <copyright file="Issue1027IncrementDecrementExpressionBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #1027 / ADR-0126: binder coverage for prefix/postfix
/// increment (`++`) and decrement (`--`) used as value-producing
/// <em>expressions</em>. Before this change the parser only recognised the
/// bare `identifier ++ / --` statement shape, so value positions
/// (`var j = i--`) and short-circuit conditions (`a && i-- > 1`)
/// failed to parse with GS0005.
open class Issue1027IncrementDecrementExpressionBinderTests {
    @Fact
    func PostfixDecrement_InInitializer_Binds_NoGS0005() {
        // Exact repro from the issue.
        const source = `
package p
func F(n int32) int32 {
  var i = n
  var j = i--
  return j
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0005")
        Assert.Empty(diagnostics)
    }

    @Fact
    func PostfixDecrement_InShortCircuitCondition_Binds() {
        const source = `
package p
func G(n int32) int32 {
  var i = n
  for i > 0 && i-- > 1 { }
  return i
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func PrefixIncrementAndDecrement_Bind() {
        const source = `
package p
func H(n int32) int32 {
  var i = n
  var j = --i
  var k = ++i
  return j + k
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func IncrementDecrement_OfArrayElement_Binds() {
        const source = `
package p
func F() int32 {
  var a = []int32{1, 2, 3}
  var x = a[0]++
  var y = --a[1]
  return x + y
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func IncrementDecrement_OfField_Binds() {
        const source = `
package p
struct S { var x int32 }
func F() int32 {
  var s = S{x: 5}
  var a = s.x++
  var b = --s.x
  return a + b
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func IncrementOfReadOnlyLet_ReportsSameDiagnosticAsAssignment() {
        const source = `
package p
func F() int32 {
  let i = 5
  var j = i++
  return j
}
`
        // A read-only `let` must be rejected with the same GS0127 the
        // assignment path reports for `i = i + 1`.
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func IncrementOfNonLvalue_ReportsGS0402() {
        const source = `
package p
func F() int32 {
  var j = 5++
  return j
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0402")
    }

    @Fact
    func IncrementOfByValueCallResult_ReportsGS0402() {
        const source = `
package p
func Value() int32 { return 5 }
func F() int32 {
  var j = Value()++
  return j
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0402")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9001")
    }

    @Fact
    func StatementForm_StillBinds_NoRegression() {
        const source = `
package p
func F() int32 {
  var i = 3
  i++
  i--
  i++
  return i
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }
    }
}
