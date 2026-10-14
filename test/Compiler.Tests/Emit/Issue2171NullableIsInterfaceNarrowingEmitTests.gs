// <copyright file="Issue2171NullableIsInterfaceNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2171 (follow-up to #2165): end-to-end CLR emit + ilverify coverage
/// proving that an `is`-interface smart cast on a NULLABLE type-parameter
/// (`T?`) or nullable interface (`IShape?`) operand narrows the
/// operand so the tested interface's member is actually invoked at runtime. A
/// nullable type-parameter operand sits on the stack as a bare slot over its
/// underlying type parameter, so it needs the same box-before-cast handling as
/// the bare `T` case.
open class Issue2171NullableIsInterfaceNarrowingEmitTests {
    @Fact
    func EndToEnd_IsInterface_OnNullableTypeParameterOperand_InvokesInterfaceMember() {
        let source = `package p
interface IInit {
    func Init() int32;
}
class Circle : IInit {
    func Init() int32 { return 13 }
}
func Probe[T](x T?) int32 {
    if x is IInit {
        return x.Init()
    }
    return -1
}
func Main() {
    System.Console.WriteLine(Probe[Circle](Circle()))
}`
        let output = CompileAndRun(source)
        Assert.Equal("13${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_IsInterface_OnNullableInterfaceOperand_InvokesInterfaceMember() {
        let source = `package p
interface IInit {
    func Init() int32;
}
interface IShape {
    func Area() int32;
}
class Circle : IShape, IInit {
    func Area() int32 { return 2 }
    func Init() int32 { return 29 }
}
func Probe(x IShape?) int32 {
    if x is IInit {
        return x.Init()
    }
    return -1
}
func Main() {
    System.Console.WriteLine(Probe(Circle()))
}`
        let output = CompileAndRun(source)
        Assert.Equal("29${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2171_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                RunCompiler(args)
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
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

        private func RunCompiler(args[]string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }
    }
}
