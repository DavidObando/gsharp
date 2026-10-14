// <copyright file="Issue1208SafeHandlePInvokeBinderTests.cs" company="GSharp">
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

/// Issue #1208 / ADR-0086 §2: `System.Runtime.InteropServices.SafeHandle`
/// and any type deriving from it (e.g.
/// `Microsoft.Win32.SafeHandles.SafeFileHandle`,
/// `Microsoft.Win32.SafeHandles.SafeWaitHandle`) marshal as P/Invoke
/// parameters and return values — the CLR marshaller performs the handle
/// ref-count / lifetime bookkeeping automatically. The binder must therefore
/// accept them and not report `GS0323` (unsupported marshalling type).
/// Arbitrary reference types remain unsupported.
open class Issue1208SafeHandlePInvokeBinderTests {
    @Fact
    func SafeFileHandleReturn_And_SafeHandleParam_NoGS0323() {
        // The canonical Win32 interop shape from the issue: CreateFile returns a
        // SafeFileHandle and ReadFile takes a SafeHandle by value.
        const source = `
package P
import System.Runtime.InteropServices
import Microsoft.Win32.SafeHandles

unsafe class C {
    shared {
        @DllImport("kernel32", SetLastError: true, CharSet: 3)
        func CreateFile(name string, a uint32, b uint32, c uint32, d uint32, e uint32, f int32) SafeFileHandle;

        @DllImport("kernel32", SetLastError: true)
        func ReadFile(handle SafeHandle, pBuffer *void, n int32, pRead *int32, ov int32) bool;
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0323")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func SafeHandleParameter_NoGS0323() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("kernel32", SetLastError: true)
func CloseHandle(handle SafeHandle) bool;
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0323")
    }

    @Fact
    func SafeFileHandleReturn_NoGS0323_NotClassReturn() {
        // A SafeHandle-derived return must bypass BOTH the generic GS0323 and
        // the class-return rejection (GS reported by ReportPInvokeClassReturnNotSupported).
        const source = `
package P
import System.Runtime.InteropServices
import Microsoft.Win32.SafeHandles

@DllImport("kernel32", SetLastError: true, CharSet: 3)
func CreateFile(name string, a uint32, b uint32, c uint32, d uint32, e uint32, f int32) SafeFileHandle;
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0323")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func SafeWaitHandle_DerivedType_NoGS0323() {
        // SafeWaitHandle derives from SafeHandle through the same base chain.
        const source = `
package P
import System.Runtime.InteropServices
import Microsoft.Win32.SafeHandles

unsafe class C {
    shared {
        @DllImport("kernel32", SetLastError: true)
        func WaitForSingleObject(handle SafeWaitHandle, ms uint32) uint32;
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0323")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ArbitraryReferenceTypeParameter_StillReportsGS0323() {
        // Negative control: SafeHandle support must NOT broaden to arbitrary
        // reference types. A StringBuilder parameter is still rejected.
        const source = `
package P
import System.Text
import System.Runtime.InteropServices

@DllImport("kernel32")
func Foo(sb StringBuilder) bool;
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0323")
    }

    @Fact
    func ArbitraryReferenceTypeReturn_StillRejected() {
        // Negative control: a non-SafeHandle reference return remains rejected.
        const source = `
package P
import System.Text
import System.Runtime.InteropServices

@DllImport("kernel32")
func Foo() StringBuilder;
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics.ToArray()
        }
    }
}
