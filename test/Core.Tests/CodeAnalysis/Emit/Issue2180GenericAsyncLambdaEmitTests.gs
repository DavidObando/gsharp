// <copyright file="Issue2180GenericAsyncLambdaEmitTests.cs" company="GSharp">
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

/// Issue #2180: a generic async lambda captured inside a generic method used to
/// emit a malformed state machine — the capture-box type argument inside
/// `MoveNext` referenced a method type-variable (`MVar`) with no slot
/// in the state-machine context (BadImageFormatException at runtime), and the
/// async result type was erased to `object` (silently miscompiling a
/// value-type result via a bogus `(Task[T])(object)` reference-cast). These
/// end-to-end tests run the emitted assembly to prove both the metadata and the
/// returned value are correct.
open class Issue2180GenericAsyncLambdaEmitTests {
    @Fact
    func GenericAsyncLambda_ValueTypeResult_ReturnsCapturedValue() {
        const Source = `package R
import System
import System.Threading.Tasks

func RunG[T](val T) Task[T] {
    let f = async () -> {
        return val
    }
    return f()
}

Console.WriteLine(RunG[int32](42).Result)
`
        Assert.Equal("42", CompileAndRun(Source, "Issue2180Value").Trim())
    }

    @Fact
    func GenericAsyncLambda_ReferenceTypeResult_ReturnsCapturedValue() {
        const Source = `package R
import System
import System.Threading.Tasks

func RunG[T](val T) Task[T] {
    let f = async () -> {
        return val
    }
    return f()
}

Console.WriteLine(RunG[String]("hello").Result)
`
        Assert.Equal("hello", CompileAndRun(Source, "Issue2180Ref").Trim())
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
