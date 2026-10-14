// <copyright file="Issue1311ImportedMethodNarrowingTests.cs" company="GSharp">
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

/// Issue #1311 — calling an imported/BCL method whose parameter is a narrower
/// integer type (e.g. `System.IO.Stream.WriteByte(byte)`) with a bare
/// in-range `int` literal must apply the same implicit constant-narrowing /
/// integer-literal adaptation (C# §10.2.11, issues #1281/#1306/#1307) already
/// applied to user-defined methods and base-constructor initializers. Imported
/// overload resolution previously tested only the lattice conversion and
/// rejected the literal with GS0159 ("Cannot find function").
open class Issue1311ImportedMethodNarrowingTests {
    @Fact
    func ImportedInstanceMethodLiteralAdaptsToNarrowerParam_BindsWithoutDiagnostics() {
        let source = `
package p
import System.IO
class C {
    func W(file Stream) {
        file.WriteByte(0)
    }
}
`
        Assert.Empty(EmitDiagnostics(source))
    }

    @Fact
    func ImportedInstanceMethodLiteralAdaptsOnDerivedReceiver_BindsWithoutDiagnostics() {
        let source = `
package p
import System.IO
class C {
    func W() {
        let ms MemoryStream = MemoryStream()
        ms.WriteByte(0)
    }
}
`
        Assert.Empty(EmitDiagnostics(source))
    }

    @Fact
    func ImportedInstanceMethodWithExplicitCast_StillBindsWithoutDiagnostics() {
        let source = `
package p
import System.IO
class C {
    func W(file Stream) {
        file.WriteByte(uint8(0))
    }
}
`
        Assert.Empty(EmitDiagnostics(source))
    }

    @Fact
    func ImportedInstanceMethodInRangeLiteralAdapts_BindsWithoutDiagnostics() {
        let source = `
package p
import System.IO
class C {
    func W(file Stream) {
        file.WriteByte(255)
    }
}
`
        Assert.Empty(EmitDiagnostics(source))
    }

    @Fact
    func ImportedInstanceMethodOutOfRangeLiteral_StillReportsDiagnostic() {
        let source = `
package p
import System.IO
class C {
    func W(file Stream) {
        file.WriteByte(300)
    }
}
`
        Assert.NotEmpty(EmitDiagnostics(source))
    }

    @Fact
    func UserMethodLiteralAdaptation_RemainsUnaffected() {
        let source = `
package p
class C {
    func U(b uint8) {}
    func W() {
        U(0)
    }
}
`
        Assert.Empty(EmitDiagnostics(source))
    }

    @Fact
    func ImportedConstructorWithNarrowAndWideOverloads_BindsToNarrowestWithoutAmbiguity() {
        // System.UIntPtr exposes both .ctor(UInt32) and .ctor(UInt64). A bare
        // in-range int literal adapts to BOTH via constant-narrowing; the
        // better-conversion-target tie-break must pick the narrower UInt32
        // overload rather than reporting GS0160 ambiguity.
        let source = `
package p
class C {
    func F() {
        let p = UIntPtr(16)
    }
}
`
        let diagnostics = EmitDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Message.Contains("ambiguous"))
        Assert.Empty(diagnostics)
    }

    @Fact
    func ImportedStaticMethodLiteralAdaptsToNarrowerParam_BindsWithoutDiagnostics() {
        // System.Buffer.SetByte(Array, int, byte) is a single-overload STATIC
        // imported method whose last parameter is `byte`. A bare in-range int
        // literal (255) must adapt via constant-narrowing on the static-call
        // path (ImportedClassSymbol.TryLookupFunction), which previously omitted
        // the check and rejected the literal with GS0159.
        let source = `
package p
import System
class C {
    func W(a []uint8) {
        Buffer.SetByte(a, 0, 255)
    }
}
`
        Assert.Empty(EmitDiagnostics(source))
    }

    @Fact
    func ImportedStaticMethodOutOfRangeLiteral_StillReportsDiagnostic() {
        // 999 does not fit `byte`, so the constant-narrowing adaptation fails and
        // the static call remains unresolved — the rule must not silently accept
        // out-of-range constants.
        let source = `
package p
import System
class C {
    func W(a []uint8) {
        Buffer.SetByte(a, 0, 999)
    }
}
`
        Assert.NotEmpty(EmitDiagnostics(source))
    }

    shared {
        private func EmitDiagnostics(source string) IReadOnlyList[Diagnostic] {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics.ToList()
        }
    }
}
