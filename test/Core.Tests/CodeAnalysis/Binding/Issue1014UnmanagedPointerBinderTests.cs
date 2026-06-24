// <copyright file="Issue1014UnmanagedPointerBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1014 / ADR-0122: binder coverage for the <c>unsafe</c> context and
/// the unmanaged raw-pointer type (CLR <c>ELEMENT_TYPE_PTR</c>). Inside an
/// unsafe context the prefix <c>*T</c> denotes an unmanaged pointer that is
/// legal as a field, local, and plain parameter type; outside an unsafe
/// context <c>*T</c> keeps its historical managed by-ref meaning and the
/// pre-existing GS9006 / GS0243 diagnostics still fire.
/// </summary>
public class Issue1014UnmanagedPointerBinderTests
{
    [Fact]
    public void PointerField_InsideUnsafeClass_NoGS9006()
    {
        const string source = @"
package P
import System

unsafe class Holder {
    var buf *int32
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9006");
    }

    [Fact]
    public void PointerField_OutsideUnsafe_ReportsGS9006()
    {
        const string source = @"
package P
import System

class Holder {
    var buf *int32
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9006");
    }

    [Fact]
    public void PointerParameter_InsideUnsafeFunc_NoGS0243()
    {
        const string source = @"
package P
import System

unsafe func takesPtr(p *int32) {
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0243");
    }

    [Fact]
    public void PointerParameter_OutsideUnsafe_ReportsGS0243()
    {
        const string source = @"
package P
import System

func takesPtr(p *int32) {
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0243");
    }

    [Fact]
    public void PointerLocal_InsideUnsafeFunc_Binds()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2, 3}
    var p *int32 = &arr[0]
    *p = 99
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void UnsafeBlock_InsideSafeFunc_Binds()
    {
        const string source = @"
package P
import System

func run() {
    var arr = []int32{1, 2, 3}
    unsafe {
        var p *int32 = &arr[0]
        *p = 99
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void PointerCast_BetweenPointerTypes_Binds()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2, 3}
    var p *int32 = &arr[0]
    var bp = *uint8(p)
    var v = bp[0]
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void NintRoundTrip_Binds()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2, 3}
    var p *int32 = &arr[0]
    var addr = nint(p)
    var p2 = *int32(addr)
    *p2 = 7
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void PointerArithmetic_Binds()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2, 3, 4}
    var p *int32 = &arr[0]
    var q = p + 2
    var r = q - 1
    *r = 9
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void PointerToNonBlittable_ReportsGS0398()
    {
        const string source = @"
package P
import System

unsafe func f(p *string) {
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0398");
    }

    [Fact]
    public void PointerDifference_SameType_BindsToNint()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var q *int32 = &arr[1]
    var d = q - p
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void PointerDifference_MismatchedType_ReportsGS0129()
    {
        const string source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var bp = *uint8(p)
    var d = p - bp
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void PInvoke_PlainPointerParameter_NoGS0323()
    {
        const string source = @"
package P
import System
import System.Runtime.InteropServices

@DllImport(""kernel32"", SetLastError: true)
unsafe func ReadFile(handle nint, buffer *uint8, count int32, read *int32, overlapped nint) bool;
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
