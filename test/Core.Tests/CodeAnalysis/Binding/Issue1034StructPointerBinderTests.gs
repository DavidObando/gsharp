// <copyright file="Issue1034StructPointerBinderTests.cs" company="GSharp">
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

/// Issue #1034 / ADR-0122 §4: binder coverage for unmanaged pointers to
/// blittable user structs (`*S`). A pointer to a blittable value struct
/// is legal as a field/local/parameter; a pointer to a non-blittable struct
/// (one with a managed reference / string field) is still rejected with
/// GS0398. Member access through the pointer binds via both the explicit
/// `(*p).field` form and the `p->field` arrow sugar.
open class Issue1034StructPointerBinderTests {
    @Fact
    func PointerToBlittableStruct_Parameter_NoGS0398() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var x int32
    var y int32
}

unsafe func f(p *Point) {
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0398")
    }

    @Fact
    func PointerToBlittableStruct_Field_NoGS0398() {
        const source = `
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
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0398")
    }

    @Fact
    func PointerToNonBlittableStruct_ReportsGS0398() {
        const source = `
package P
import System.Runtime.InteropServices

struct Managed {
    var name string
    var x int32
}

unsafe func f(p *Managed) {
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0398")
    }

    @Fact
    func PointerToNullableValueTypes_ReportsGS0398() {
        const source = `package P

struct Pair {
    var x int32
    var y int32
}

unsafe func primitive(p *int32?) {}
unsafe func valueStruct(p *Pair?) {}`
        let diagnostics = GetDiagnostics(source).Where((d Diagnostic) -> d.Id == "GS0398").ToArray()
        Assert.Equal(2, diagnostics.Length)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Location.Text!!.ToString(d.Location.Span) == "int32?")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Location.Text!!.ToString(d.Location.Span) == "Pair?")
    }

    @Fact
    func DereferenceMemberAccess_Binds_NoErrors() {
        const source = `
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
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ArrowMemberAccess_Binds_NoErrors() {
        const source = `
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
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ArrowCompoundAssignment_WithCallReceiver_Binds_NoErrors() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var x int32
    var y int32
}

unsafe func GetPtr(p *Point) *Point {
    return p
}

unsafe func run() {
    var arr = []Point{Point{x: 1, y: 2}}
    GetPtr(&arr[0])->x += 5
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func PointerToBlittableStruct_Arithmetic_NoErrors() {
        const source = `
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
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func StructPointer_PInvokeParameter_NoShapeError() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var x int32
    var y int32
}

@DllImport("nativelib", EntryPoint: "use_point")
unsafe func use_point(p *Point) int32;
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0398")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0349" || d.Id == "GS0352")
    }

    @Fact
    func ArrowLambda_StillWorks_OutsideUnsafe() {
        const source = `
package P
import System

func run() {
    let f (int32) -> int32 = x -> x + 1
    var r = f(41)
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ParenthesizedLambda_StillWorks_InsideUnsafe() {
        const source = `
package P
import System

unsafe func run() {
    let f (int32) -> int32 = (x) -> x + 1
    var r = f(41)
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
