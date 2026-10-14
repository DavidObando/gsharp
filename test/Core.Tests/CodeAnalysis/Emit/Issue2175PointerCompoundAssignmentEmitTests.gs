// <copyright file="Issue2175PointerCompoundAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2175 / ADR-0122 §5: inside an `unsafe` context the binary
/// pointer arithmetic forms `p + i` / `p - i` bind and lower to
/// scaled native-int arithmetic, but the compound-assignment forms
/// `p += i` / `p -= i` were rejected with GS0129 even though
/// `p += i` is exactly `p = p + i`. The fix makes the compound
/// binder reuse the SAME pointer binary-operator lowering when the target is
/// an unmanaged pointer (`*T`), generalizing across every legal pointee
/// type, both `+=` and `-=`, and any integer RHS the binary path
/// accepts.
open class Issue2175PointerCompoundAssignmentEmitTests {
    @Fact
    func PointerCompoundAssignment_UInt8_Binds() {
        // The exact repro from issue #2175: `ArithBinary` already compiled;
        // `ArithCompound` used to error GS0129 on both `+=` and `-=`.
        const Source = `
package R
unsafe class P {
    unsafe func ArithBinary(pBuf *uint8, n int32) *uint8 {
        var q = pBuf + n
        return q
    }
    unsafe func ArithCompound(pBuf *uint8, n int32) *uint8 {
        var q = pBuf
        q += n
        q -= n
        return q
    }
}
`
        let diagnostics = GetDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func PointerCompoundAssignment_Int32Pointee_Binds() {
        // Generalizes beyond `*uint8`: a `*int32` pointee scales by 4.
        const Source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2, 3, 4}
    var p *int32 = &arr[0]
    var q = p
    q += 2
    q -= 1
}
`
        let diagnostics = GetDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func PointerCompoundAssignment_VoidPointee_ReportsGS0403() {
        // A `*void` pointer has no element size, so compound arithmetic must be
        // rejected exactly as the binary `p + i` form rejects it (ADR-0122 §3).
        const Source = `
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var v = *void(p)
    v += 1
}
`
        let diagnostics = GetDiagnostics(Source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0403")
    }

    @Fact
    func PointerCompoundAssignment_PlusEquals_Int32_AdvancesScaledByElementSize() {
        // `q += 2` on a `*int32` must advance by 2 elements (8 bytes), landing
        // on arr[2], identical to `q = q + 2`.
        const Source = `package Issue2175PlusEq
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    var q = p
    q += 2
    Console.WriteLine(*q)
    q -= 1
    Console.WriteLine(*q)
}

run()
`
        let output = CompileAndRun(Source, "Issue2175PlusEq")
        let lines = output.Split([]string{Environment.NewLine, "\n"}, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("7", lines[0])
        Assert.Equal("5", lines[1])
    }

    @Fact
    func PointerCompoundAssignment_UInt8_AdvancesByOneByteElement() {
        // A `*uint8` pointee scales by 1: `q += 3` lands on arr[3].
        const Source = `package Issue2175UInt8
import System

unsafe func run() {
    var arr = []uint8{10, 20, 30, 40}
    var p *uint8 = &arr[0]
    var q = p
    q += 3
    Console.WriteLine(*q)
    q -= 2
    Console.WriteLine(*q)
}

run()
`
        let output = CompileAndRun(Source, "Issue2175UInt8")
        let lines = output.Split([]string{Environment.NewLine, "\n"}, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("40", lines[0])
        Assert.Equal("20", lines[1])
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }

        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
