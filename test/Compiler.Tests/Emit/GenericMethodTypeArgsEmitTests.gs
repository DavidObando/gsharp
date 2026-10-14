// <copyright file="GenericMethodTypeArgsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #311: invoking a generic method with an EXPLICIT type-argument list
/// (`Method[T](...)`) end-to-end (gsc → PE → dotnet exec). Covers the
/// forms that type inference cannot supply because the type argument itself is
/// the information being provided (e.g. `Array.Empty[T]()`,
/// `Enumerable.Empty[T]()`), single and multiple type arguments, and the
/// generic-extension-method-with-receiver form. All tests run under bare
/// `gsc /targetframework` (no explicit `/r:`), keeping them
/// independent of the cross-load-context concern tracked by #310.
open class GenericMethodTypeArgsEmitTests {
    @Fact
    func StaticGenericMethod_SingleExplicitTypeArg_ArrayEmpty() {
        let source = `package P
import System

var a = Array.Empty[string]()
Console.WriteLine(a.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func StaticGenericMethod_SingleExplicitTypeArg_EnumerableEmpty() {
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

var e = Enumerable.Empty[int32]()
Console.WriteLine(e.Count())`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func StaticGenericMethod_MultipleExplicitTypeArgs_KeyValuePairCreate() {
        let source = `package P
import System
import System.Collections.Generic

var pair = KeyValuePair.Create[string, int32]("answer", 42)
Console.WriteLine(pair.Key)
Console.WriteLine(pair.Value)`
        let output = CompileAndRun(source)
        Assert.Equal("answer${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func GenericExtensionMethod_ExplicitTypeArg_OnReceiver() {
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

var words = List[string]()
words.Add("alpha")
words.Add("beta")
var wordArray = words.ToArray[string]()
Console.WriteLine(wordArray.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func TypeInference_StillWorks_AlongsideExplicitForm() {
        let source = `package P
import System
import System.Linq

var repeated = Enumerable.Repeat("x", 3)
Console.WriteLine(repeated.Count())`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_generic_method_typeargs_").FullName
            try {
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
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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
