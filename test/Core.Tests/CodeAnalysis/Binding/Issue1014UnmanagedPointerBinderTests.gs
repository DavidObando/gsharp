// <copyright file="Issue1014UnmanagedPointerBinderTests.cs" company="GSharp">
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

/// Issue #1014 / ADR-0122: binder coverage for the `unsafe` context and
/// the unmanaged raw-pointer type (CLR `ELEMENT_TYPE_PTR`). Inside an
/// unsafe context the prefix `*T` denotes an unmanaged pointer that is
/// legal as a field, local, and plain parameter type; outside an unsafe
/// context `*T` keeps its historical managed by-ref meaning and the
/// pre-existing GS9006 / GS0243 diagnostics still fire.
open class Issue1014UnmanagedPointerBinderTests {
    @Fact
    func PointerField_InsideUnsafeClass_NoGS9006() {
        const source = `
package P
import System

unsafe class Holder {
    var buf *int32
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9006")
    }

    @Fact
    func PointerField_OutsideUnsafe_ReportsGS9006() {
        const source = `
package P
import System

class Holder {
    var buf *int32
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9006")
    }

    @Fact
    func PointerParameter_InsideUnsafeFunc_NoGS0243() {
        const source = `
package P
import System

unsafe func takesPtr(p *int32) {
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0243")
    }

    @Fact
    func PointerParameter_OutsideUnsafe_ReportsGS0243() {
        const source = `
package P
import System

func takesPtr(p *int32) {
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0243")
    }

    @Fact
    func PointerLocal_InsideUnsafeFunc_Binds() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2, 3}
    var p *int32 = &arr[0]
    *p = 99
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func UnsafeBlock_InsideSafeFunc_Binds() {
        const source = `
package P
import System

func run() {
    var arr = []int32{1, 2, 3}
    unsafe {
        var p *int32 = &arr[0]
        *p = 99
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func PointerCast_BetweenPointerTypes_Binds() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2, 3}
    var p *int32 = &arr[0]
    var bp = *uint8(p)
    var v = bp[0]
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func PointerCast_ExplicitAliasWinsOutsideUnrelatedNestedHomonym() {
        const source = `
package P
import Folder = System.Guid

class Holder {
    data struct Folder(Value int32) { }
}

unsafe func Cast(value nint) *Folder {
    return *Folder(value)
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func PointerCast_LexicalNestedTypeWinsInsideContainer() {
        const source = `
package P
import Folder = System.Guid

class Holder {
    data struct Folder(Value int32) { }

    shared {
        unsafe func Cast(value nint) *Folder {
            return *Folder(value)
        }
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func NintRoundTrip_Binds() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2, 3}
    var p *int32 = &arr[0]
    var addr = nint(p)
    var p2 = *int32(addr)
    *p2 = 7
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func PointerArithmetic_Binds() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2, 3, 4}
    var p *int32 = &arr[0]
    var q = p + 2
    var r = q - 1
    *r = 9
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func PointerToNonBlittable_ReportsGS0398() {
        const source = `
package P
import System

unsafe func f(p *string) {
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0398")
    }

    @Fact
    func PointerDifference_SameType_BindsToNint() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var q *int32 = &arr[1]
    var d = q - p
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func PointerDifference_MismatchedType_ReportsGS0129() {
        const source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var bp = *uint8(p)
    var d = p - bp
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func PInvoke_PlainPointerParameter_NoGS0323() {
        const source = `
package P
import System
import System.Runtime.InteropServices

@DllImport("kernel32", SetLastError: true)
unsafe func ReadFile(handle nint, buffer *uint8, count int32, read *int32, overlapped nint) bool;
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
