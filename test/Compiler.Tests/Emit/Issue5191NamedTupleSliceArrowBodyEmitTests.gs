// <copyright file="Issue5191NamedTupleSliceArrowBodyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #5191: an expression-bodied function or property whose type is a slice of a
/// named tuple type, with a literal of two or more elements, must compile, pass
/// ILVerify, and return the literal's values.
open class Issue5191NamedTupleSliceArrowBodyEmitTests {
    @Fact
    func NamedTupleSliceArrowBody_TwoElements_RunsAndVerifies() {
        let source = `package P

func Rows() [](A int64, B object?) -> [](A int64, B object?){(A: 1, B: nil), (A: 20, B: "x")}

class Holder {
    prop Items [](A int64, B string) -> [](A int64, B string){(A: 3, B: "p"), (A: 4, B: "q")}
}

public var result int32 = 0
let rows = Rows()
let items = Holder().Items
result = int32(rows.Length) * 1000 + int32(rows[1].A) * 100 + int32(items[0].A) * 10 + int32(items[1].A)`
        Assert.Equal(2000 + 2000 + 30 + 4, RunAndGetIntResult(source))
    }

    @Fact
    func NamedTupleSliceArrowBody_BindsWithoutDiagnostics() {
        const source = "package P\n" +
            "func M1() [](A int64, B string) -> [](A int64, B string){(A: 1, B: \"q\"), (A: 2, B: \"x\")}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue5191.gs"))
        let compilation = Compilation(ReferenceResolver.Default(), tree){IsLibrary = true}
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream, refStream: nil)
        Assert.Empty(result.Diagnostics)
        Assert.True(result.Success)
    }

    @Fact
    func NamedTupleSliceArrowBody_ElementTypeMismatch_ReportsBindingDiagnosticAtTheLiteral() {
        const source = "package P\n" +
            "func M1() [](A int64, B string) -> [](A int64, B string){(A: 1, B: \"q\"), (A: \"bad\", B: \"x\")}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue5191.gs"))
        let compilation = Compilation(ReferenceResolver.Default(), tree){IsLibrary = true}
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream, refStream: nil)
        let diagnostics = result.Diagnostics.ToArray()
        Assert.NotEmpty(diagnostics)
        Assert.All(diagnostics, (d Diagnostic) -> Assert.NotEqual("GS0005", d.Id))
        Assert.All(diagnostics, (d Diagnostic) -> Assert.Equal(2, d.Location.StartLine + 1))
    }

    shared {
        private func RunAndGetIntResult(source string) int32 {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue5191_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            let output = compileOut.ToString() + compileErr.ToString()
            Assert.True(compileExit == 0, (`gsc failed:
` + "$output"))
            IlVerifier.Verify(outPath)
            let assembly = EmittedFixture.Load(outPath)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return int32(resultField!!.GetValue(nil)!!)
        }
    }
}
