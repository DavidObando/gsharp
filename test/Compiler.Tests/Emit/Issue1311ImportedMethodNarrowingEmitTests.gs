// <copyright file="Issue1311ImportedMethodNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1311: end-to-end CLR emit + ilverify coverage proving that calling an
/// imported/BCL method whose parameter is a narrower integer type
/// (`System.IO.Stream.WriteByte(byte)`) with a bare in-range `int`
/// literal binds, emits a correctly-typed `uint8` constant, and produces
/// the right runtime bytes (C# §10.2.11, issues #1281/#1306/#1307). The literal
/// must round-trip through `MemoryStream` with the exact written values.
open class Issue1311ImportedMethodNarrowingEmitTests {
    @Fact
    func EndToEnd_ImportedWriteByteLiteralAdapts_ProducesCorrectBytes() {
        let source = `package p
import System
import System.IO
func Main() {
    var ms = MemoryStream()
    ms.WriteByte(65)
    ms.WriteByte(0)
    ms.WriteByte(255)
    var bytes = ms.ToArray()
    Console.WriteLine(int32(bytes.Length))
    Console.WriteLine(int32(bytes[0]))
    Console.WriteLine(int32(bytes[1]))
    Console.WriteLine(int32(bytes[2]))
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "3${Environment.NewLine}65${Environment.NewLine}0${Environment.NewLine}255${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Library_ImportedWriteByteLiteralAdapts_PassesIlVerify() {
        let source = `package p
import System.IO
class C {
    func W(file Stream) {
        file.WriteByte(0)
    }
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1311_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            RunCompiler(args)
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1311_exe_").FullName
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

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil && Directory.Exists(dir) {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
