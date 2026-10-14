// <copyright file="Issue1036UnsafeMethodSignatureBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #1036 / ADR-0122 §1: an `unsafe func` method declared inside an
/// otherwise-<em>safe</em> type now binds its SIGNATURE (parameter + return
/// types) in an unsafe context too — not just its body — so a single unsafe
/// method may take/return unmanaged raw pointers (`*T` →
/// (cref:PointerTypeSymbol)). A non-`unsafe` method's signature
/// keeps its historical managed by-ref meaning (GS0243), confirming the change
/// is gated on the per-method `unsafe` modifier.
open class Issue1036UnsafeMethodSignatureBinderTests {
    @Fact
    func UnsafeMethod_InSafeClass_PointerParameter_NoGS0243() {
        const source = `
package P
import System

class Safe {
    unsafe func f(p *int32) {
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0243")
    }

    @Fact
    func UnsafeMethod_InSafeStruct_PointerParameter_NoGS0243() {
        const source = `
package P
import System

struct Safe {
    unsafe func f(p *int32) {
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0243")
    }

    @Fact
    func SafeMethod_InSafeClass_PointerParameter_StillReportsGS0243() {
        const source = `
package P
import System

class Safe {
    func f(p *int32) {
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0243")
    }

    @Fact
    func UnsafeStaticMethod_InSafeClass_PointerParameter_NoGS0243() {
        const source = `
package P
import System

class Safe {
    shared {
        unsafe func f(p *int32) {
        }
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0243")
    }

    @Fact
    func UnsafeMethod_InSafeClass_ParameterIsUnmanagedPointer() {
        const source = `
package P
import System

class Safe {
    unsafe func f(p *int32) {
    }
}
`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        let type = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Safe")
        let method = type.Methods.Single((m FunctionSymbol) -> m.Name == "f")
        let parameterType = method.Parameters.Single((p ParameterSymbol) -> p.Name == "p").Type
        Assert.IsType[PointerTypeSymbol](parameterType)
        Assert.Equal(TypeSymbol.Int32, (cast[PointerTypeSymbol](parameterType)).PointeeType)
    }

    @Fact
    func UnsafeMethod_InSafeClass_ReturnTypeIsUnmanagedPointer() {
        const source = `
package P
import System

class Safe {
    unsafe func f(p *int32) *int32 {
        return p
    }
}
`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        let type = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Safe")
        let method = type.Methods.Single((m FunctionSymbol) -> m.Name == "f")
        Assert.IsType[PointerTypeSymbol](method.Type)
        Assert.Equal(TypeSymbol.Int32, (cast[PointerTypeSymbol](method.Type)).PointeeType)
    }

    @Fact
    func SafeMethod_InSafeClass_ParameterIsManagedByRef() {
        const source = `
package P
import System

class Safe {
    func f(p *int32) {
    }
}
`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        let type = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Safe")
        let method = type.Methods.Single((m FunctionSymbol) -> m.Name == "f")
        let parameterType = method.Parameters.Single((p ParameterSymbol) -> p.Name == "p").Type
        Assert.IsType[ByRefTypeSymbol](parameterType)
    }

    @Fact
    func UnsafeMethod_InSafeStruct_VoidPointerParameter_NoGS0243() {
        const source = `
package P
import System

struct Safe {
    unsafe func f(p *void) {
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0243")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0398")
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
