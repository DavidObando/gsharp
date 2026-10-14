// <copyright file="Issue1139OutVarStaticCallBinderTests.cs" company="GSharp">
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

/// Issue #1139 / ADR-0060 (follow-up to #1133): an inline `out var n` (and
/// `out let n` / `out _`) declaration at a <em>qualified static</em>
/// (`shared`) method call site (`C.G(out var y)`) was accepted but
/// never declared the local in the enclosing block scope, so a subsequent read
/// of `n` failed with `GS0125`. The instance path
/// (`BindUserInstanceCall`) was fixed by #1137; the static path
/// (`BindUserTypeStaticCall`) never re-bound the first-pass placeholder.
/// These tests cover the qualified static call, a cross-type-qualified call,
/// the read-only (`out let`) and discard (`out _`) forms, and a
/// generic static out-parameter, plus regression guards.
open class Issue1139OutVarStaticCallBinderTests {
    @Fact
    func QualifiedStatic_OutVar_DeclaresLocalInEnclosingScope_NoGS0125() {
        // Exact repro from the issue.
        const source = `
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out var y)
            return y
        }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(diagnostics)
    }

    @Fact
    func CrossTypeQualifiedStatic_OutVar_DeclaresLocalInEnclosingScope_NoGS0125() {
        const source = `
package p
class Other {
    shared {
        func G(out x int32) { x = 5 }
    }
}
class C {
    shared {
        func F() int32 {
            Other.G(out var y)
            return y
        }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(diagnostics)
    }

    @Fact
    func QualifiedStatic_OutLet_DeclaresReadOnlyLocal_ReadIsFine() {
        const source = `
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out let y)
            return y
        }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func QualifiedStatic_OutLet_AssigningAfterwards_ReportsReadOnly() {
        const source = `
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out let y)
            y = 9
            return y
        }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func QualifiedStatic_OutDiscard_DoesNotLeakName() {
        const source = `
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out _)
            return _
        }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func QualifiedStatic_OutDiscard_AloneCompiles() {
        const source = `
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out _)
            return 1
        }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func GenericQualifiedStatic_OutVar_BindsSubstitutedType_NoDiagnostics() {
        // The out-var local must bind as the substituted parameter pointee
        // type (int32 here), not the open type parameter `T`.
        const source = `
package p
class C {
    shared {
        func M[T](seed T, out result T) { result = seed }
        func F() int32 {
            C.M[int32](7, out var y)
            return y
        }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(diagnostics)
    }

    @Fact
    func QualifiedStatic_PreDeclaredOutLocal_StillCompiles() {
        // Regression guard: the existing pre-declared form must keep working.
        const source = `
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            var y int32
            C.G(out y)
            return y
        }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func QualifiedStatic_NormalCallWithoutOutVar_StillBinds() {
        // No-regression: a normal qualified static call without an out-var
        // still binds cleanly.
        const source = `
package p
class C {
    shared {
        func G(x int32) int32 { return x + 1 }
        func F() int32 {
            return C.G(4)
        }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func QualifiedStatic_UnknownMethod_StillReportsDiagnostic() {
        // No-regression: an unknown qualified static method still reports a
        // diagnostic (the inline-out-var rebind must not swallow it).
        const source = `
package p
class C {
    shared {
        func F() int32 {
            C.Missing(out var y)
            return y
        }
    }
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func InstanceForm_OutVar_StillWorks_Regression1137() {
        // Regression guard for #1137: the instance path must keep working after
        // the shared-helper refactor.
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

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }
    }
}
