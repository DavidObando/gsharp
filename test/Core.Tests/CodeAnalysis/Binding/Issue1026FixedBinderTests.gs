// <copyright file="Issue1026FixedBinderTests.cs" company="GSharp">
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

/// Issue #1026 / ADR-0125: binder coverage for the `fixed` statement
/// (`fixed <name> *T = <source> { ... }`), which pins a
/// managed array/slice or string and binds an unmanaged `*T` pointer to
/// its first element for the duration of the body. The statement is only
/// legal inside an `unsafe` context (GS0400) and the source must be a
/// pinnable buffer whose element type matches the pointer's pointee (GS0401).
open class Issue1026FixedBinderTests {
    @Fact
    func SliceSource_InUnsafeContext_Binds() {
        const source = `
package p
unsafe func F(dest []uint8) {
    fixed pD *uint8 = dest { }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func StringSource_InUnsafeContext_Binds() {
        const source = `
package p
unsafe func F() {
    fixed pC *uint16 = "ABC" { }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func UnsafeBlock_EstablishesContext_Binds() {
        const source = `
package p
func F(dest []uint8) {
    unsafe {
        fixed pD *uint8 = dest { }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func OutsideUnsafeContext_ReportsGS0400() {
        const source = `
package p
func F(dest []uint8) {
    fixed pD *uint8 = dest { }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0400")
    }

    @Fact
    func UnpinnableSource_ReportsGS0401() {
        const source = `
package p
unsafe func F() {
    fixed p *int32 = int32(5) { }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0401")
    }

    @Fact
    func ElementTypeMismatch_ReportsGS0401() {
        const source = `
package p
unsafe func F(dest []uint8) {
    fixed p *int32 = dest { }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0401")
    }

    @Fact
    func PointerVariableScopedToBody() {
        // The bound `*T` pointer is only valid inside the body; referencing it
        // after the block must not resolve.
        const source = `
package p
import System
unsafe func F(dest []uint8) {
    fixed pD *uint8 = dest { }
    Console.WriteLine(nint(pD))
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
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
