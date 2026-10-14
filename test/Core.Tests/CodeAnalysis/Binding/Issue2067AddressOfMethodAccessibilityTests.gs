// <copyright file="Issue2067AddressOfMethodAccessibilityTests.cs" company="GSharp">
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
import Xunit

/// Issue #2067 (follow-up from #2065 / #2058): `&Foo.Method` (the
/// method-group-to-delegate / managed-function-pointer conversion, ADR-0122
/// §9) resolves through (cref:GSharp.Core.CodeAnalysis.Binding.ExpressionBinder)'s
/// address-of binder, a separate path from regular calls, so
/// (cref:AccessibilityChecker.IsAccessible) was never consulted there —
/// taking the address of a `private`/`protected` static method from
/// outside its declaring type went undiagnosed. Mirrors
/// `Issue2058PrivateMethodCallAccessibilityTests` for `&Method`.
open class Issue2067AddressOfMethodAccessibilityTests {
    @Fact
    func ExternalCode_TakesAddressOfPrivateStaticMethod_ReportsGS0472() {
        let source = `
package P

class Foo {
    shared {
        private func Secret() int32 { return 42 }
    }
}

unsafe func run() {
    let fp *func() int32 = &Foo.Secret
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_TakesAddressOfProtectedStaticMethod_ReportsGS0379NotGS0472() {
        let source = `
package P

open class Foo {
    shared {
        protected func Guarded() int32 { return 7 }
    }
}

unsafe func run() {
    let fp *func() int32 = &Foo.Guarded
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0379")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func InternalCode_TakesAddressOfPrivateStaticMethodFromSameType_NoDiagnostics() {
        let source = `
package P

class Foo {
    shared {
        private func Secret() int32 { return 42 }

        unsafe func run() {
            let fp *func() int32 = &Foo.Secret
        }
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_TakesAddressOfPublicStaticMethod_NoDiagnostics() {
        let source = `
package P

class Foo {
    shared {
        func Reveal() int32 { return 42 }
    }
}

unsafe func run() {
    let fp *func() int32 = &Foo.Reveal
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0472")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0379")
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
