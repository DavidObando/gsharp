// <copyright file="Issue1034StructPointerBinderTests.cs" company="GSharp">
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
/// Issue #1034 / ADR-0122 §4: binder coverage for unmanaged pointers to
/// blittable user structs (<c>*S</c>). A pointer to a blittable value struct
/// is legal as a field/local/parameter; a pointer to a non-blittable struct
/// (one with a managed reference / string field) is still rejected with
/// GS0398. Member access through the pointer binds via both the explicit
/// <c>(*p).field</c> form and the <c>p-&gt;field</c> arrow sugar.
/// </summary>
public class Issue1034StructPointerBinderTests
{
    [Fact]
    public void PointerToBlittableStruct_Parameter_NoGS0398()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var x int32
    var y int32
}

unsafe func f(p *Point) {
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0398");
    }

    [Fact]
    public void PointerToBlittableStruct_Field_NoGS0398()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var x int32
    var y int32
}

unsafe class Holder {
    var p *Point
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0398");
    }

    [Fact]
    public void PointerToNonBlittableStruct_ReportsGS0398()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

struct Managed {
    var name string
    var x int32
}

unsafe func f(p *Managed) {
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0398");
    }

    [Fact]
    public void DereferenceMemberAccess_Binds_NoErrors()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var x int32
    var y int32
}

unsafe func run() {
    var arr = []Point{Point{x: 1, y: 2}}
    var p = &arr[0]
    (*p).y = 5
    var v = (*p).x
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void ArrowMemberAccess_Binds_NoErrors()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var x int32
    var y int32
}

unsafe func run() {
    var arr = []Point{Point{x: 1, y: 2}}
    var p = &arr[0]
    var v = p->x
    p->y = 5
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void PointerToBlittableStruct_Arithmetic_NoErrors()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var x int32
    var y int32
}

unsafe func run() {
    var arr = []Point{Point{x: 1, y: 2}, Point{x: 3, y: 4}}
    var p = &arr[0]
    var q = p + 1
    var d = q - p
    var r = q - 1
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void StructPointer_PInvokeParameter_NoShapeError()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var x int32
    var y int32
}

@DllImport(""nativelib"", EntryPoint: ""use_point"")
unsafe func use_point(p *Point) int32;
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0398");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0349" || d.Id == "GS0352");
    }

    [Fact]
    public void ArrowLambda_StillWorks_OutsideUnsafe()
    {
        const string source = @"
package P
import System

func run() {
    let f (int32) -> int32 = x -> x + 1
    var r = f(41)
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void ParenthesizedLambda_StillWorks_InsideUnsafe()
    {
        const string source = @"
package P
import System

unsafe func run() {
    let f (int32) -> int32 = (x) -> x + 1
    var r = f(41)
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
