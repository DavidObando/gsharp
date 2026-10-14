// <copyright file="Issue1599EnumTryParseOutVarTests.cs" company="GSharp">
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

/// Issue #1599: `Enum.TryParse<TEnum>(string, out TEnum)` (a generic
/// BCL method whose type parameter has a value-type/`struct` constraint)
/// invoked over a SAME-COMPILATION user enum must resolve and bind — both with
/// an inline `out var` declaration and with a pre-declared receiver.
///
/// Before the fix the inline `out var` form crashed the compiler with an
/// internal `GS9999` because the value-type placeholder used to close the
/// method leaked into the synthesized local's type, and the pre-declared form
/// failed with `GS0159` because the by-ref user-enum argument could not
/// match the value-type-constrained by-ref parameter.
open class Issue1599EnumTryParseOutVarTests {
    @Fact
    func InlineOutVar_EnumTryParse_ResolvesAndBinds_NoDiagnostics() {
        // Exact repro from the issue: inline `out var` over a user enum.
        const source = `
package p
import System

enum Color { Red, Green }

var ok = Enum.TryParse[Color]("Red", out var result)
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Empty(diagnostics)
    }

    @Fact
    func InlineOutVar_ResultLocal_IsTypedAsTheEnum() {
        // The synthesized local must carry the enum type, not the placeholder
        // (which is what leaked and caused GS9999).
        const source = `
package p
import System

enum Color { Red, Green }

var ok = Enum.TryParse[Color]("Red", out var result)
var reuse Color = result
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.Empty(diagnostics)
    }

    @Fact
    func InlineOutVar_IgnoreCaseOverload_ResolvesAndBinds() {
        const source = `
package p
import System

enum Color { Red, Green }

var ok = Enum.TryParse[Color]("red", true, out var result)
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Empty(diagnostics)
    }

    @Fact
    func PreDeclaredReceiver_EnumTryParse_Resolves_NoGS0159() {
        const source = `
package p
import System

enum Color { Red, Green }

var r Color = Color.Red
var ok = Enum.TryParse[Color]("Green", out r)
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Empty(diagnostics)
    }

    @Fact
    func BclEnum_InlineOutVar_StillResolves_Regression() {
        // Control: a real BCL enum (with a CLR type) keeps resolving through
        // the ordinary path, not the placeholder recovery.
        const source = `
package p
import System

var ok = Enum.TryParse[DayOfWeek]("Monday", out var d)
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics.ToList()
        }
    }
}
