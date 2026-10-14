// <copyright file="Issue4350ConversionOperatorOwnerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #4350: an in-body conversion operator is owned by its ENCLOSING type,
/// as in C#. It used to be attached to the source type, which changed the
/// declaring type in metadata and, when the source type's own `shared`
/// block bound later, dropped the operator from the assembly entirely (the
/// migrated `ReadOnlySlice.op_Implicit(Slice)` vanished).
open class Issue4350ConversionOperatorOwnerEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func InBodyConversionOperator_IsDeclaredOnEnclosingType(sourceFileFirst bool) {
        let output = if sourceFileFirst {
            CompileAndRun(Inner, View)
        } else {
            CompileAndRun(View, Inner)
        }
        Assert.Equal(Lines("x", "True", "True"), output)
    }

    shared {
        private const Inner string = `package P

struct Inner[T](Value T) {
    func AsView() View[T] -> View[T](this)

    shared {
        func Make(value T) Inner[T] -> Inner[T]{Value: value}
    }
}`

        private const View string = `package P
import System

struct View[T] {
    private let inner Inner[T]

    internal init(inner Inner[T]) {
        this.inner = inner
    }

    prop Value T -> inner.Value

    func operator implicit(value Inner[T]) View[T] -> value.AsView()
}

let view View[string] = Inner[string].Make("x")
Console.WriteLine(view.Value)
let viewType = typeof(View[string])
let op = viewType.GetMethod("op_Implicit")
Console.WriteLine(op?.DeclaringType == viewType)
Console.WriteLine(typeof(Inner[string]).GetMethod("op_Implicit") == nil)`

        private func Lines(lines ...string) string -> string.Concat(
            Array.ConvertAll(lines, (line string) -> (line + Environment.NewLine))
        )

        private func CompileAndRun(sources ...string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4350_convowner_").FullName
            try {
                let outPath = Path.Combine(tempDir, "test.dll")
                let sourcePaths = [sources.Length]string
                for var i = 0; i < sources.Length; i++ {
                    sourcePaths[i] = Path.Combine(tempDir, "test$i.gs")
                    File.WriteAllText(sourcePaths[i], sources[i])
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    let compileArgs = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                    compileArgs.AddRange(sourcePaths)
                    compileExit = Program.Main(compileArgs.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
