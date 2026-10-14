// <copyright file="Issue1056ClassConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1056: end-to-end CLR emit + ilverify coverage for a generic
/// constrained by a USER-declared base class (`where T : BaseClass`).
/// Validates that instance-member dispatch through the base-class constraint
/// emits the verifiable `constrained. !!T callvirt Animal::Speak()`
/// sequence, that a GenericParamConstraint metadata row pointing at the class is
/// produced (so ilverify accepts the assembly), and that virtual dispatch
/// resolves the most-derived override at runtime.
open class Issue1056ClassConstraintEmitTests {
    @Fact
    func EndToEnd_BaseClassConstraint_DispatchesVirtualOverrideAndPrintsWoof() {
        let source = `package p
open class Animal { open func Speak() string { return "..." } }
open class Dog : Animal { override func Speak() string { return "woof" } }
func Describe[T Animal](x T) string { return x.Speak() }
func Main() { System.Console.WriteLine(Describe[Dog](Dog())) }`
        let output = CompileAndRun(source)
        Assert.Equal("woof${Environment.NewLine}", output)
    }

    @Fact
    func Library_BaseClassConstraint_PassesIlVerify() {
        // ilverify is invoked unconditionally by CompileLibrary; a missing
        // GenericParamConstraint row or a bare (un-constrained) callvirt on the
        // unboxed type parameter would fail verification here.
        let source = `package p
open class Animal { open func Speak() string { return "..." } }
func Describe[T Animal](x T) string { return x.Speak() }`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func Library_SelfReferentialBaseClassConstraints_PassIlVerify() {
        // The CRTP `[T Box]` and `[T Box[T]]` shapes over a user-declared class
        // that names itself in its own type-parameter constraint.
        let source = `package p
open class Box[T Box] { }
open class Box2[T Box2[T]] { }`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1056_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            RunCompiler(args)
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1056_exe_").FullName
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
