// <copyright file="Issue1613UnsignedLdindEmitTests.cs" company="GSharp">
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

/// Issue #1613: `EmitLoadIndirect` used `ldind.i1`/`ldind.i2` for
/// unsigned pointees (uint8/uint16/char/bool), sign-extending values with the
/// high bit set. A ref/out param or ref-aliasing local dereference of such a
/// value produced a negative int32 instead of the correct unsigned widening.
/// Mirrors the already-correct `EmitLoadElement` fix from issue #520.
open class Issue1613UnsignedLdindEmitTests {
    @Fact
    func RefUInt8Parameter_HighBitSet_ReadsAsUnsigned() {
        const Source = `package Issue1613RefUInt8
import System

func checkByte(ref b uint8) {
    if b == 200 {
        Console.WriteLine("ok")
    } else {
        Console.WriteLine("bad")
    }
}

var v uint8 = 200
checkByte(&v)
`
        let output = CompileAndRun(Source, "Issue1613RefUInt8")
        Assert.Contains("ok", output)
    }

    @Fact
    func RefUInt16Parameter_HighBitSet_ReadsAsUnsigned() {
        const Source = `package Issue1613RefUInt16
import System

func checkUShort(ref u uint16) {
    if u == 40000 {
        Console.WriteLine("ok")
    } else {
        Console.WriteLine("bad")
    }
}

var v uint16 = 40000
checkUShort(&v)
`
        let output = CompileAndRun(Source, "Issue1613RefUInt16")
        Assert.Contains("ok", output)
    }

    @Fact
    func OutUInt8Parameter_HighBitSet_FlowsBackAsUnsigned() {
        const Source = `package Issue1613OutUInt8
import System

func produce(out b uint8) {
    b = 200
}

var r uint8 = 0
produce(&r)
Console.WriteLine(r)
`
        let output = CompileAndRun(Source, "Issue1613OutUInt8")
        Assert.Contains("200", output)
        Assert.DoesNotContain("-56", output)
    }

    shared {
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
