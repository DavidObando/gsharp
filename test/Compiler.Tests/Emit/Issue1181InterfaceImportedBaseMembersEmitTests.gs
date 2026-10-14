// <copyright file="Issue1181InterfaceImportedBaseMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1181: a user-defined interface that extends a BCL/imported interface
/// surfaces the imported interface's members on user-interface-typed receivers.
/// These tests give end-to-end CLR emit + ilverify coverage and confirm that a
/// call to an inherited imported member (e.g. `IDisposable.Dispose`)
/// dispatches correctly at runtime when invoked through the user interface.
open class Issue1181InterfaceImportedBaseMembersEmitTests {
    @Fact
    func EndToEnd_ImportedBaseInterfaceMethod_DispatchesThroughUserInterface() {
        // IBox extends System.IDisposable. Calling b.Dispose() through an
        // IBox-typed parameter must dispatch to Box's implementation.
        let source = `package p
import System
interface IBox : IDisposable { prop N int32 { get; } }
class Box : IBox {
    prop N int32 { get; init; }
    func Dispose() { Console.WriteLine("disposed") }
}
func Use(b IBox) { b.Dispose() }
func Main() { Use(Box()) }`
        let output = CompileAndRun(source)
        Assert.Equal("disposed${Environment.NewLine}", output)
    }

    @Fact
    func Library_ImportedBaseInterfaceProperty_ReadThroughUserInterface_PassesIlVerify() {
        // IBox extends System.Collections.ICollection; reading b.Count through
        // an IBox-typed reference must emit verifiable IL (a `callvirt
        // get_Count` on the IBox receiver, which carries an InterfaceImpl row
        // to ICollection).
        let source = `package p
import System.Collections
interface IBox : ICollection { prop N int32 { get; } }
func Use(b IBox) int32 { return b.Count }`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func Library_TransitiveGenericEnumerableThroughUserInterface_PassesIlVerify() {
        // IEnumerable<int32> transitively extends the non-generic IEnumerable;
        // GetEnumerator surfaced through the user interface must emit
        // verifiable IL.
        let source = `package p
import System.Collections.Generic
interface IBox : IEnumerable[int32] { prop N int32 { get; } }
func Use(b IBox) { let e = b.GetEnumerator() }`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1181_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            RunCompiler(args)
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1181_exe_").FullName
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
