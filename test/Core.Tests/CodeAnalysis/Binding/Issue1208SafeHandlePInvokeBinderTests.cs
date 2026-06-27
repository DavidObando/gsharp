// <copyright file="Issue1208SafeHandlePInvokeBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1208 / ADR-0086 §2: <c>System.Runtime.InteropServices.SafeHandle</c>
/// and any type deriving from it (e.g.
/// <c>Microsoft.Win32.SafeHandles.SafeFileHandle</c>,
/// <c>Microsoft.Win32.SafeHandles.SafeWaitHandle</c>) marshal as P/Invoke
/// parameters and return values — the CLR marshaller performs the handle
/// ref-count / lifetime bookkeeping automatically. The binder must therefore
/// accept them and not report <c>GS0323</c> (unsupported marshalling type).
/// Arbitrary reference types remain unsupported.
/// </summary>
public class Issue1208SafeHandlePInvokeBinderTests
{
    [Fact]
    public void SafeFileHandleReturn_And_SafeHandleParam_NoGS0323()
    {
        // The canonical Win32 interop shape from the issue: CreateFile returns a
        // SafeFileHandle and ReadFile takes a SafeHandle by value.
        const string source = @"
package P
import System.Runtime.InteropServices
import Microsoft.Win32.SafeHandles

unsafe class C {
    shared {
        @DllImport(""kernel32"", SetLastError: true, CharSet: 3)
        func CreateFile(name string, a uint32, b uint32, c uint32, d uint32, e uint32, f int32) SafeFileHandle;

        @DllImport(""kernel32"", SetLastError: true)
        func ReadFile(handle SafeHandle, pBuffer *void, n int32, pRead *int32, ov int32) bool;
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0323");
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void SafeHandleParameter_NoGS0323()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""kernel32"", SetLastError: true)
func CloseHandle(handle SafeHandle) bool;
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0323");
    }

    [Fact]
    public void SafeFileHandleReturn_NoGS0323_NotClassReturn()
    {
        // A SafeHandle-derived return must bypass BOTH the generic GS0323 and
        // the class-return rejection (GS reported by ReportPInvokeClassReturnNotSupported).
        const string source = @"
package P
import System.Runtime.InteropServices
import Microsoft.Win32.SafeHandles

@DllImport(""kernel32"", SetLastError: true, CharSet: 3)
func CreateFile(name string, a uint32, b uint32, c uint32, d uint32, e uint32, f int32) SafeFileHandle;
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0323");
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void SafeWaitHandle_DerivedType_NoGS0323()
    {
        // SafeWaitHandle derives from SafeHandle through the same base chain.
        const string source = @"
package P
import System.Runtime.InteropServices
import Microsoft.Win32.SafeHandles

unsafe class C {
    shared {
        @DllImport(""kernel32"", SetLastError: true)
        func WaitForSingleObject(handle SafeWaitHandle, ms uint32) uint32;
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0323");
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void ArbitraryReferenceTypeParameter_StillReportsGS0323()
    {
        // Negative control: SafeHandle support must NOT broaden to arbitrary
        // reference types. A StringBuilder parameter is still rejected.
        const string source = @"
package P
import System.Text
import System.Runtime.InteropServices

@DllImport(""kernel32"")
func Foo(sb StringBuilder) bool;
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0323");
    }

    [Fact]
    public void ArbitraryReferenceTypeReturn_StillRejected()
    {
        // Negative control: a non-SafeHandle reference return remains rejected.
        const string source = @"
package P
import System.Text
import System.Runtime.InteropServices

@DllImport(""kernel32"")
func Foo() StringBuilder;
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics.ToArray();
    }
}
