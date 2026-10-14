// <copyright file="Issue1203SharedExternBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// ADR-0086 / issue #1203: a bodyless function inside a class's
/// `shared { }` static block is the canonical G# spelling of a C#
/// `static extern [DllImport]` member. Previously the static-member path
/// dereferenced the null `Declaration.Body` and crashed the compiler with
/// a GS9998 NullReferenceException. These tests pin that a static
/// `@DllImport` extern now binds as a P/Invoke and that a bodyless static
/// method without `@DllImport` reports GS0325 instead of crashing.
open class Issue1203SharedExternBinderTests {
    @Fact
    func StaticDllImportExtern_BindsAsPInvoke() {
        const source = `
package p
import System.Runtime.InteropServices

class C {
    shared {
        @DllImport("kernel32", SetLastError: true)
        func ReadFile(handle System.IntPtr, n int32) bool;
    }
}
`
        let globalScope = BindSource(source)
        let structSym = globalScope.Structs.Single((s StructSymbol) -> s.Name == "C")
        let method = structSym.StaticMethods.Single((m FunctionSymbol) -> m.Name == "ReadFile")
        Assert.True(method.IsPInvoke)
        Assert.NotNull(method.PInvokeMetadata)
        Assert.Equal("kernel32", method.PInvokeMetadata!!.LibraryName)
        Assert.True(method.PInvokeMetadata!!.SetLastError)
    }

    @Fact
    func BodylessStaticFunc_WithoutDllImport_ReportsGS0325_DoesNotCrash() {
        const source = `
package p
class C {
    shared {
        func F(x int32) bool;
    }
}
`
        let diagnostics = GetEmitDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0325")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func StaticDllImportExtern_DoesNotCrash_NoGS9998() {
        const source = `
package p
import System.Runtime.InteropServices

class C {
    shared {
        @DllImport("kernel32")
        func GetTickCount() int32;
    }
}
`
        let diagnostics = GetEmitDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0325")
    }

    @Fact
    func StaticDllImportExtern_InUnsafeClass_WithPointerParams_Binds() {
        const source = `
package p
import System.Runtime.InteropServices

unsafe class C {
    shared {
        @DllImport("kernel32", SetLastError: true)
        func ReadFile(handle System.IntPtr, pBuffer *void, n int32, pRead *int32, ov int32) bool;
    }
}
`
        let diagnostics = GetEmitDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func GetEmitDiagnostics(source string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }
    }
}
