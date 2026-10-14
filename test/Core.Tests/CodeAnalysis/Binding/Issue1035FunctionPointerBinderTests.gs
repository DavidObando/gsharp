// <copyright file="Issue1035FunctionPointerBinderTests.cs" company="GSharp">
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

/// Issue #1035 / ADR-0122 §9: binder coverage for managed function pointers
/// (`*func(T1, T2) R`). A function pointer is legal as a local /
/// parameter / return / field inside an `unsafe` context; `&Method`
/// yields a function-pointer value type-checked against the target type; a
/// function-pointer value is directly invokable (`fp(args)`). Use outside
/// an unsafe context is rejected with GS0404, and an instance/overloaded
/// method address-of is rejected with GS0405.
open class Issue1035FunctionPointerBinderTests {
    @Fact
    func ManagedFunctionPointer_LocalAndCall_NoError() {
        const source = `
package P
import System

unsafe func add(a int32, b int32) int32 {
    return a + b
}

unsafe func run() {
    let fp *func(int32, int32) int32 = &add
    var r = fp(1, 2)
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ManagedFunctionPointer_Parameter_NoError() {
        const source = `
package P
import System

unsafe func add(a int32, b int32) int32 {
    return a + b
}

unsafe func apply(fp *func(int32, int32) int32, x int32, y int32) int32 {
    return fp(x, y)
}

unsafe func run() {
    var r = apply(&add, 3, 4)
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ManagedFunctionPointer_VoidReturn_NoError() {
        const source = `
package P
import System

unsafe func greet() {
}

unsafe func run() {
    let fp *func() = &greet
    fp()
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ManagedFunctionPointer_OutsideUnsafe_ReportsGS0404() {
        const source = `
package P
import System

func run() {
    let fp *func(int32) int32 = nil
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0404")
    }

    @Theory
    @InlineData("")
    @InlineData(" = nil")
    func ManagedFunctionPointer_TopLevel_ReportsGS0404(initializer string) {
        let source = `
package P
import System

var fp *func(int32) int32` + initializer + "\n"
        let diagnostics = GetDiagnostics(source).ToArray()
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0404")
        Assert.Equal("*", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0303")
    }

    @Fact
    func DelegatePointer_InsideUnsafe_ReportsGS0398() {
        const source = `
package P

unsafe func run() {
    var fp *((int32) -> int32) = nil
}
`
        let diagnostics = GetDiagnostics(source).ToArray()
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0398")
        Assert.Equal("(int32) -> int32", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0303")
    }

    @Fact
    func ManagedFunctionPointer_ConversionDiagnostic_UsesSourceSpelling() {
        const source = `
package P

unsafe func Take(fp *func(int32) int32) {
}

unsafe func run() {
    Take(1)
}
`
        let diagnostics = GetDiagnostics(source).ToArray()
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0154")
        Assert.Equal("1", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Contains("*func(int32) int32", diagnostic.Message)
    }

    @Fact
    func AddressOfInstanceMethod_ReportsGS0405() {
        const source = `
package P
import System

class C {
    func m(a int32) int32 {
        return a
    }
}

unsafe func run() {
    var c = C()
    let fp *func(int32) int32 = &c.m
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0405")
    }

    @Fact
    func NintRoundTrip_NoError() {
        const source = `
package P
import System

unsafe func add(a int32, b int32) int32 {
    return a + b
}

unsafe func run() {
    let fp *func(int32, int32) int32 = &add
    var n = nint(fp)
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
