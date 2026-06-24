// <copyright file="Issue1033VoidPointerBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1033 / ADR-0122 §3: binder coverage for the true void-element pointer
/// <c>*void</c> (the faithful mapping of C# <c>void*</c>, distinct from the byte
/// pointer <c>*uint8</c>). A <c>*void</c> may be declared, round-tripped through
/// <c>nint</c>/<c>IntPtr</c>, and cast to/from typed pointers <c>*T</c>, but it
/// may not be directly dereferenced (<c>*p</c>), indexed (<c>p[i]</c>), or used
/// in pointer arithmetic (<c>p + i</c>, <c>p - i</c>, <c>p - q</c>) — those are
/// rejected with GS0403.
/// </summary>
public class Issue1033VoidPointerBinderTests
{
    [Fact]
    public void VoidPointerField_InsideUnsafeClass_NoError()
    {
        const string source = @"
package P
import System

unsafe class Holder {
    var buf *void
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void VoidPointer_CastFromTypedPointer_NoError()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void VoidPointer_NintRoundTripAndTypedCast_NoError()
    {
        const string source = @"
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
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void VoidPointer_Dereference_ReportsGS0403()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var v = *vp
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0403");
    }

    [Fact]
    public void VoidPointer_DereferenceWrite_ReportsGS0403()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    *vp = 5
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0403");
    }

    [Fact]
    public void VoidPointer_IndexRead_ReportsGS0403()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var v = vp[0]
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0403");
    }

    [Fact]
    public void VoidPointer_IndexWrite_ReportsGS0403()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    vp[0] = 5
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0403");
    }

    [Fact]
    public void VoidPointer_AdditionOffset_ReportsGS0403()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var q = vp + 1
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0403");
    }

    [Fact]
    public void VoidPointer_SubtractionOffset_ReportsGS0403()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var q = vp - 1
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0403");
    }

    [Fact]
    public void VoidPointer_Difference_ReportsGS0403()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var vp = *void(p)
    var vq = *void(p)
    var d = vp - vq
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0403");
    }

    [Fact]
    public void VoidPointer_Equality_NoError()
    {
        // Comparison/equality on a void pointer is allowed (it compares as a
        // native int) — only deref/index/arithmetic require a typed-pointer cast.
        const string source = @"
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
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void VoidPointer_AsPInvokeParameter_NoGS0323()
    {
        // ADR-0122 §3 / issue #1033: a true `*void` (C# `void*`, the canonical
        // Win32 opaque-buffer parameter) marshals as a native pointer, so the
        // P/Invoke binder must accept it (no GS0323).
        const string source = @"
package P
import System
import System.Runtime.InteropServices

@DllImport(""kernel32"", SetLastError: true)
unsafe func ReadFile(handle nint, buffer *void, count int32, read *int32, overlapped nint) bool;
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0323");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
