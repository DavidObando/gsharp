// <copyright file="RelationalPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Regression coverage for issue #421 (P2-4): relational patterns must
/// emit unsigned/unordered comparison opcodes for unsigned-integer,
/// char, and floating-point discriminants. Previously the emitter
/// hard-coded `Clt`/`Cgt`, which yields wrong answers for
/// `uint32`/`uint64`/`nuint`/`char` boundary values
/// and disagrees with IEEE NaN semantics for `float32`/`float64`.
open class RelationalPatternEmitTests {
    @Fact
    func RelationalPattern_UInt32_Boundary_UsesUnsignedComparison() {
        // 0xFFFFFFFFu is uint.MaxValue. Treated as signed it is -1 and
        // would NOT satisfy `> 1u`; with unsigned Cgt_un it does.
        const Source = `package P
import System
let v = 4294967295u
let r = switch v { case > 1u: "hi" default: "lo" }
Console.WriteLine(r)
`
        Assert.Contains("hi", CompileLoadInvokeCaptureStdout(Source, "RelPatUInt32"))
    }

    @Fact
    func RelationalPattern_UInt32_GreaterOrEqual_UsesUnsignedComparison() {
        const Source = `package P
import System
let v = 4294967295u
let r = switch v { case >= 2u: "ge" default: "lt" }
Console.WriteLine(r)
`
        Assert.Contains("ge", CompileLoadInvokeCaptureStdout(Source, "RelPatUInt32Ge"))
    }

    @Fact
    func RelationalPattern_UInt64_Boundary_UsesUnsignedComparison() {
        // 0xFFFFFFFFFFFFFFFF is ulong.MaxValue. Signed Clt would mis-order.
        const Source = `package P
import System
let v = 18446744073709551615UL
let r = switch v { case > 1UL: "hi" default: "lo" }
Console.WriteLine(r)
`
        Assert.Contains("hi", CompileLoadInvokeCaptureStdout(Source, "RelPatUInt64"))
    }

    @Fact
    func RelationalPattern_UInt64_LessOrEqual_UsesUnsignedComparison() {
        // 1UL <= ulong.MaxValue must hold. With signed Cgt this evaluates
        // wrong because ulong.MaxValue is sign-interpreted as -1.
        const Source = `package P
import System
let v = 1UL
let r = switch v { case <= 18446744073709551615UL: "le" default: "gt" }
Console.WriteLine(r)
`
        Assert.Contains("le", CompileLoadInvokeCaptureStdout(Source, "RelPatUInt64Le"))
    }

    @Fact
    func RelationalPattern_Char_HighCodepoint_UsesUnsignedComparison() {
        // '\uFFFE' compared against 'A' (0x41). Signed Clt would view it
        // as negative when widened — must compare as unsigned 16-bit.
        const Source = `package P
import System
let c = '\uFFFE'
let r = switch c { case > 'A': "hi" default: "lo" }
Console.WriteLine(r)
`
        Assert.Contains("hi", CompileLoadInvokeCaptureStdout(Source, "RelPatChar"))
    }

    @Fact
    func RelationalPattern_Float64_NaN_UsesUnorderedComparison() {
        // IEEE-754: every ordered relation involving NaN must be false.
        // For strict <, >: signed Clt/Cgt already return false on NaN.
        // For <=, >=: must use Cgt_un/Clt_un so the negation flips to false.
        const Source = `package P
import System
let v = 0.0 / 0.0
let g  = switch v { case >  0.0: "gt" default: "nope" }
let l  = switch v { case <  0.0: "lt" default: "nope" }
let ge = switch v { case >= 0.0: "ge" default: "nope" }
let le = switch v { case <= 0.0: "le" default: "nope" }
Console.WriteLine(g)
Console.WriteLine(l)
Console.WriteLine(ge)
Console.WriteLine(le)
`
        let output = CompileLoadInvokeCaptureStdout(Source, "RelPatFloat64NaN")
        Assert.Equal(
            "nope${Environment.NewLine}nope${Environment.NewLine}nope${Environment.NewLine}nope${Environment.NewLine}",
            output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func RelationalPattern_Float32_NaN_UsesUnorderedComparison() {
        const Source = `package P
import System
let v = 0.0f / 0.0f
let g  = switch v { case >  0.0f: "gt" default: "nope" }
let ge = switch v { case >= 0.0f: "ge" default: "nope" }
let le = switch v { case <= 0.0f: "le" default: "nope" }
Console.WriteLine(g)
Console.WriteLine(ge)
Console.WriteLine(le)
`
        let output = CompileLoadInvokeCaptureStdout(Source, "RelPatFloat32NaN")
        Assert.Equal(
            "nope${Environment.NewLine}nope${Environment.NewLine}nope${Environment.NewLine}",
            output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func RelationalPattern_Float64_NormalValues_StillWork() {
        const Source = `package P
import System
let v = 1.5
let r = switch v { case > 1.0: "hi" default: "lo" }
Console.WriteLine(r)
`
        Assert.Contains("hi", CompileLoadInvokeCaptureStdout(Source, "RelPatFloat64Pos"))
    }

    @Fact
    func RelationalPattern_Int32_Signed_StillUsesSignedComparison() {
        // Negative signed values must still satisfy `< 0`. Regression
        // guard ensuring we did not accidentally flip *signed* discriminants
        // to unsigned opcodes.
        const Source = `package P
import System
let v = -5
let r = switch v { case < 0: "neg" default: "nn" }
Console.WriteLine(r)
`
        Assert.Contains("neg", CompileLoadInvokeCaptureStdout(Source, "RelPatInt32Signed"))
    }

    shared {
        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
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
