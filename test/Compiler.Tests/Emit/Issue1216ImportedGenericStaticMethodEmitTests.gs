// <copyright file="Issue1216ImportedGenericStaticMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1216: an explicit type argument on a call to an IMPORTED (CLR)
/// generic static method whose open return type <em>embeds</em> the method
/// type parameter — e.g. `GC.AllocateArray[T](n) → T[]` or
/// `Array.Empty[T]() → T[]` — must close the CLR method over the explicit
/// type argument and surface the substituted return type, including when the
/// type argument is a same-compilation user type (which is erased to
/// `object` in the reflection load context and recovered via the symbolic
/// projection). Before the fix the return type collapsed to the erased
/// `object[]` (GS0155). These tests round-trip gsc → PE → dotnet exec,
/// proving a correctly-instantiated `MethodSpec` is emitted.
open class Issue1216ImportedGenericStaticMethodEmitTests {
    @Fact
    func ImportedGenericStatic_AllocateArray_UserStructTypeArg() {
        let source = `package P
import System

struct Foo { var X int32 }

func Make(n int32) []Foo { return GC.AllocateArray[Foo](n) }

var a = Make(3)
Console.WriteLine(a.Length)
Console.WriteLine(a[1].X)`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func ImportedGenericStatic_ArrayEmpty_UserStructTypeArg() {
        let source = `package P
import System

struct Foo { var X int32 }

func Empty() []Foo { return Array.Empty[Foo]() }

var a = Empty()
Console.WriteLine(a.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func ImportedGenericStatic_AllocateArray_PrimitiveTypeArg() {
        let source = `package P
import System

func Make(n int32) []int32 { return GC.AllocateArray[int32](n) }

var a = Make(4)
Console.WriteLine(a.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1216_").FullName
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
