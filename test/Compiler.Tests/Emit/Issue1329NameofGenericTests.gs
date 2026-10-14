// <copyright file="Issue1329NameofGenericTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1329: `nameof(...)` accepts a constructed/generic type argument
/// and folds to the unqualified type name as a compile-time constant string,
/// with the type arguments dropped — matching C# (`nameof(List<int>)`
/// → `"List"`). These tests compile and run emitted programs and assert the
/// printed bare type names, covering:
/// - a generic over a concrete type (`List[int32]`).
/// - a generic over a type parameter (`IAppleData[TData]`).
/// - a multi-argument generic (`Dictionary[string, int32]`).
/// - a nested generic argument (`List[List[int32]]`).
/// - regression: the bare-name and member-access forms still work.
open class Issue1329NameofGenericTests {
    @Fact
    func GenericOverConcreteType_YieldsBareName() {
        let source = `package P
import System

class List[T] {}

Console.WriteLine(nameof(List[int32]))`
        Assert.Equal("List${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericOverTypeParameter_YieldsBareName() {
        let source = `package P
import System

interface IAppleData[TData] {}

class C {
    func F[TData](x TData) string -> nameof(IAppleData[TData])
}

Console.WriteLine(C().F(5))`
        Assert.Equal("IAppleData${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func MultiArgGeneric_YieldsBareName() {
        let source = `package P
import System

class Dictionary[K, V] {}

Console.WriteLine(nameof(Dictionary[string, int32]))`
        Assert.Equal("Dictionary${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NestedGeneric_YieldsOuterBareName() {
        let source = `package P
import System

class List[T] {}

Console.WriteLine(nameof(List[List[int32]]))`
        Assert.Equal("List${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func BareNameAndMemberAccess_StillWork() {
        // Regression: the existing accepted forms (plain identifier and member
        // access) keep their behaviour alongside the new generic form.
        let source = `package P
import System

class List[T] {}

Console.WriteLine(nameof(List))
Console.WriteLine(nameof(Console.WriteLine))`
        Assert.Equal("List${Environment.NewLine}WriteLine${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1329_emit_").FullName
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
