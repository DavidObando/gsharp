// <copyright file="Issue1024StackAllocBinderTests.cs" company="GSharp">
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

/// Issues #1024, #1057, #1041 / ADR-0124: binder coverage for the
/// `stackalloc [n]T` stack-allocation expression in G#-style array
/// grammar (the bracketed count first, then the element type). The default
/// (safe) form yields a `System.Span<T>` and needs no
/// `unsafe` context; the pointer form (`var p *T = stackalloc [n]T`)
/// yields the raw `T*` inside an unsafe context. The element type must be
/// blittable/unmanaged. An optional initializer (`stackalloc [n]T{…}` or
/// the count-inferred `stackalloc []T{…}`) supplies the element values.
open class Issue1024StackAllocBinderTests {
    @Fact
    func SafeSpanForm_Binds_NoGS0125() {
        // The original issue repro previously failed with GS0125
        // ("Variable 'stackalloc' doesn't exist.") because `stackalloc` was
        // parsed as an identifier reference rather than an expression.
        const source = `
package p
func F() { var buf = stackalloc [4]uint8 }
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(diagnostics)
    }

    @Fact
    func SafeSpanForm_ResultIsSpan() {
        const source = `
package p
import System
func F() {
    var buf = stackalloc [3]int32
    Console.WriteLine(buf.Length)
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func SafeSpanForm_NoUnsafeContextRequired() {
        const source = `
package p
func F() {
    var buf = stackalloc [8]uint8
    buf[0] = uint8(1)
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func NonBlittableElementType_ReportsGS0399() {
        const source = `
package p
func F() { var buf = stackalloc [4]string }
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0399")
    }

    @Fact
    func UndefinedElementType_ReportsGS0113() {
        const source = `
package p
func F() { var buf = stackalloc [4]Nope }
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    @Fact
    func PointerForm_InsideUnsafe_Binds() {
        const source = `
package p
import System
unsafe func run() {
    var p *int32 = stackalloc [3]int32
    p[0] = 1
    Console.WriteLine(p[0])
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func RuntimeLengthCount_Binds() {
        const source = `
package p
func F(n int32) {
    var buf = stackalloc [n]uint8
    buf[0] = uint8(0)
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func StackAllocIsContextualKeyword_PlainIdentifierStillWorks() {
        // `stackalloc` is only a keyword in the exact `stackalloc [` shape; any
        // other position keeps lexing it as a plain identifier.
        const source = `
package p
import System
func F() {
    var stackalloc = 5
    Console.WriteLine(stackalloc + 1)
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func InitializerForm_ExplicitCount_Binds() {
        const source = `
package p
import System
func F() {
    var buf = stackalloc [3]int32{1, 2, 3}
    Console.WriteLine(buf.Length)
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func InitializerForm_CountInferred_Binds() {
        const source = `
package p
import System
func F() {
    var buf = stackalloc []int32{1, 2, 3}
    Console.WriteLine(buf.Length)
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func InitializerForm_PointerInsideUnsafe_Binds() {
        const source = `
package p
import System
unsafe func run() {
    var p *int32 = stackalloc [3]int32{4, 5, 6}
    Console.WriteLine(p[0])
}
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Empty(diagnostics)
    }

    @Fact
    func CountInferredWithoutInitializer_ReportsGS0411() {
        const source = `
package p
func F() { var buf = stackalloc []int32 }
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0411")
    }

    @Fact
    func InitializerLengthMismatch_ReportsGS0412() {
        const source = `
package p
func F() { var buf = stackalloc [2]int32{1, 2, 3} }
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0412")
    }

    @Fact
    func InitializerForm_NonBlittableElement_ReportsGS0399() {
        const source = `
package p
func F() { var buf = stackalloc []string{"a", "b"} }
`
        let diagnostics = GetDiagnostics(source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0399")
    }

    @Fact
    func SafeSpanForm_PassesToImportedReadOnlySpanParameter() {
        const source = `
package p
import System.Text
func F() {
    let bytes = stackalloc [4]uint8
    let text = Encoding.ASCII.GetString(bytes.Slice(0, 3))
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
