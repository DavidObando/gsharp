// <copyright file="Issue1035FixedBufferBinderTests.cs" company="GSharp">
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

/// Issue #1035 / ADR-0122 §10: binder coverage for fixed-size buffer fields
/// (`fixed name [N]T`). A fixed buffer is legal inside an `unsafe`
/// struct with a blittable primitive element type and a positive constant
/// length; use outside an unsafe context (GS0406), a non-supported element
/// type (GS0409), and a non-positive length (GS0408) are rejected.
open class Issue1035FixedBufferBinderTests {
    @Fact
    func FixedBuffer_InsideUnsafeStruct_NoError() {
        const source = `
package P
import System

unsafe struct Buf {
    fixed data [8]int32
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func FixedBuffer_OutsideUnsafe_ReportsGS0406() {
        const source = `
package P
import System

struct Buf {
    fixed data [8]int32
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0406")
    }

    @Fact
    func FixedBuffer_NonBlittableElement_ReportsGS0409() {
        const source = `
package P
import System

unsafe struct Buf {
    fixed data [4]string
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0409")
    }

    @Fact
    func FixedBuffer_IndexThroughPointer_NoError() {
        const source = `
package P
import System

unsafe struct Buf {
    fixed data [8]int32
}

unsafe func run() {
    var b = Buf{}
    var p = &b
    p->data[0] = 1
    var x = p->data[0]
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
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
