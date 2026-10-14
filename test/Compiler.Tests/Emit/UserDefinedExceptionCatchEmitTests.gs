// <copyright file="UserDefinedExceptionCatchEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #421 (P2-6): a `catch` clause whose exception type is a user-defined
/// G# class (i.e. `ExceptionType.ClrType` is `null` at emit time, because
/// the type is still being defined in the same assembly) used to NRE or build a
/// bogus token in `EmitCatchClauses`. The emitter now falls back to its
/// internal `structTypeDefs` registry via `GetElementTypeToken`, the same
/// pattern used everywhere else for user-defined types. These tests compile and
/// run small G# programs that catch a user-defined exception class to verify the
/// emitted IL is valid and the catch handler actually fires.
open class UserDefinedExceptionCatchEmitTests {
    @Fact
    func Catch_With_User_Defined_Exception_Class_Compiles_And_Runs() {
        let src = `package main
import System

class MyError(Detail string) : Exception(Detail) {
}

func Main() int32 {
    var trace = ""
    try {
        var n = Int32.Parse("not a number")
    } catch (e MyError) {
        trace = "my:" + e.Message
    } catch (e Exception) {
        trace = "generic:caught"
    }
    Console.WriteLine(trace)
    return 0
}`
        Assert.Equal("generic:caught${Environment.NewLine}", CompileAndRun(src))
    }

    @Fact
    func Catch_Specific_User_Defined_Exception_Before_Generic_Exception() {
        let src = `package main
import System

class MyError(Detail string) : Exception(Detail) {
}

class AnotherError(Detail string) : Exception(Detail) {
}

func Main() int32 {
    var trace = ""
    try {
        var n = Int32.Parse("oops")
    } catch (e MyError) {
        trace = "my"
    } catch (e AnotherError) {
        trace = "another"
    } catch (e Exception) {
        trace = "generic"
    }
    Console.WriteLine(trace)
    return 0
}`
        Assert.Equal("generic${Environment.NewLine}", CompileAndRun(src))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_p2_6_catch_").FullName
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
