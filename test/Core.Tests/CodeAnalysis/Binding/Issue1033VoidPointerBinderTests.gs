// <copyright file="Issue1033VoidPointerBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import Xunit

/// Issue #1033 / ADR-0122 §3: binder coverage for the true void-element pointer
/// `*void` (the faithful mapping of C# `void*`, distinct from the byte
/// pointer `*uint8`). A `*void` may be declared, round-tripped through
/// `nint`/`IntPtr`, and cast to/from typed pointers `*T`, but it
/// may not be directly dereferenced (`*p`), indexed (`p[i]`), or used
/// in pointer arithmetic (`p + i`, `p - i`, `p - q`) — those are
/// rejected with GS0403.
open class Issue1033VoidPointerBinderTests {
    @Fact
    func VoidPointerField_InsideUnsafeClass_NoError() {
        const source = `
package P
import System

unsafe class Holder {
    var buf *void
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func VoidPointer_CastFromTypedPointer_NoError() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func VoidPointer_NintRoundTripAndTypedCast_NoError() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var addr = nint(vp)
    var vp2 = *void(addr)
    var ip = *int32(vp2)
    var v = *ip
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func VoidPointer_Dereference_ReportsGS0403() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var v = *vp
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0403")
    }

    @Fact
    func VoidPointer_DereferenceWrite_ReportsGS0403() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    *vp = 5
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0403")
    }

    @Fact
    func VoidPointer_IndexRead_ReportsGS0403() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var v = vp[0]
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0403")
    }

    @Fact
    func VoidPointer_IndexWrite_ReportsGS0403() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    vp[0] = 5
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0403")
    }

    @Fact
    func VoidPointer_AdditionOffset_ReportsGS0403() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var q = vp + 1
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0403")
    }

    @Fact
    func VoidPointer_SubtractionOffset_ReportsGS0403() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var q = vp - 1
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0403")
    }

    @Fact
    func VoidPointer_Difference_ReportsGS0403() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var vq = *void(p)
    var d = vp - vq
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0403")
    }

    @Fact
    func VoidPointer_Equality_NoError() {
        // Comparison/equality on a void pointer is allowed (it compares as a
        // native int) — only deref/index/arithmetic require a typed-pointer cast.
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var vq = *void(p)
    var eq = vp == vq
    var ne = vp != vq
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func VoidPointer_AsPInvokeParameter_NoGS0323() {
        // ADR-0122 §3 / issue #1033: a true `*void` (C# `void*`, the canonical
        // Win32 opaque-buffer parameter) marshals as a native pointer, so the
        // P/Invoke binder must accept it (no GS0323).
        const source = `
package P
import System
import System.Runtime.InteropServices

@DllImport("kernel32", SetLastError: true)
unsafe func ReadFile(handle nint, buffer *void, count int32, read *int32, overlapped nint) bool;
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0323")
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
