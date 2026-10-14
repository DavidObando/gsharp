// <copyright file="Issue1043FixedPinnableBinderTests.cs" company="GSharp">
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

/// Issue #1043 / ADR-0125: binder coverage for pinning a span-like source via
/// `GetPinnableReference` in a `fixed` statement. A source whose type
/// exposes a public instance `ref T GetPinnableReference()` (canonically
/// `System.Span[T]` / `System.ReadOnlySpan[T]`) now binds without
/// GS0401; a source without such a method (and with a mismatched pointee) is
/// still rejected with GS0401.
open class Issue1043FixedPinnableBinderTests {
    @Fact
    func SpanSource_InUnsafeContext_Binds() {
        const source = `
package p
import System
unsafe func F(dest []uint8) {
    var sp Span[uint8] = dest
    fixed pD *uint8 = sp { }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func ReadOnlySpanSource_InUnsafeContext_Binds() {
        const source = `
package p
import System
unsafe func F(dest []uint8) {
    var ros ReadOnlySpan[uint8] = dest
    fixed pR *uint8 = ros { }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func SpanSource_OutsideUnsafeContext_ReportsGS0400() {
        const source = `
package p
import System
func F(dest []uint8) {
    var sp Span[uint8] = dest
    fixed pD *uint8 = sp { }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0400")
    }

    @Fact
    func SpanSource_PointeeMismatch_ReportsGS0401() {
        const source = `
package p
import System
unsafe func F(dest []uint8) {
    var sp Span[uint8] = dest
    fixed p *int32 = sp { }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0401")
    }

    @Fact
    func NonPinnableSource_WithoutGetPinnableReference_ReportsGS0401() {
        // A `List[uint8]` exposes no public instance `ref T GetPinnableReference()`,
        // so it remains an unpinnable source.
        const source = `
package p
import System
import System.Collections.Generic
unsafe func F() {
    var lst List[uint8]
    fixed p *uint8 = lst { }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0401")
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
