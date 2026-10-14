// <copyright file="Issue1133OutVarEnclosingScopeBinderTests.cs" company="GSharp">
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

/// Issue #1133 / ADR-0060: an inline `out var n` (and `out let n` /
/// `out _`) declaration at a <em>user instance method</em> call site was
/// accepted but never declared the local in the enclosing block scope, so a
/// subsequent read of `n` failed with `GS0125`. The free-function and
/// imported-method paths already re-bound the first-pass placeholder; the
/// user-instance path (`BindUserInstanceCall`) did not. These tests cover
/// implicit-`this` and explicit-receiver calls, the read-only (`out
/// let`) and discard (`out _`) forms, and a generic out-parameter.
open class Issue1133OutVarEnclosingScopeBinderTests {
    @Fact
    func ImplicitThis_OutVar_DeclaresLocalInEnclosingScope_NoGS0125() {
        // Exact repro from the issue.
        const source = `
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out var y)
        return y
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(diagnostics)
    }

    @Fact
    func ExplicitReceiver_OutVar_DeclaresLocalInEnclosingScope_NoGS0125() {
        const source = `
package p
class C {
    func G(out x int32) { x = 5 }
}
class D {
    func F(c C) int32 {
        c.G(out var y)
        return y
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(diagnostics)
    }

    @Fact
    func OutLet_DeclaresReadOnlyLocal_ReadIsFine() {
        const source = `
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out let y)
        return y
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func OutLet_AssigningAfterwards_ReportsReadOnly() {
        const source = `
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out let y)
        y = 9
        return y
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func OutDiscard_DoesNotLeakName() {
        const source = `
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out _)
        return _
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func OutDiscard_AloneCompiles() {
        const source = `
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out _)
        return 1
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func GenericOutParameter_OutVar_BindsSubstitutedType_NoDiagnostics() {
        // The out-var local must bind as the substituted parameter pointee
        // type (int32 here), not the open type parameter `T`.
        const source = `
package p
class C {
    func M[T](seed T, out result T) { result = seed }
    func F() int32 {
        M[int32](7, out var y)
        return y
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(diagnostics)
    }

    @Fact
    func Control_PreDeclaredOutLocal_StillCompiles() {
        // Regression guard: the existing pre-declared form must keep working.
        const source = `
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        var y int32
        G(out y)
        return y
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
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
