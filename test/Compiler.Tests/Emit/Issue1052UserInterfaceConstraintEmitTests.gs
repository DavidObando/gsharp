// <copyright file="Issue1052UserInterfaceConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1052: end-to-end CLR emit + ilverify coverage for a generic
/// constrained by a USER-declared (non-sealed) interface. Validates that
/// instance-member dispatch through the constraint emits the verifiable
/// `constrained. !!T callvirt IShape::Area()` sequence, that a
/// GenericParamConstraint metadata row is produced (so ilverify accepts the
/// assembly), and that the program runs and prints the expected value.
open class Issue1052UserInterfaceConstraintEmitTests {
    @Fact
    func EndToEnd_NonSealedUserInterfaceConstraint_DispatchesAndPrints9() {
        let source = `package p
import System

interface IShape { func Area() float64; }

struct Sq : IShape {
    var S float64
    func Area() float64 { return S * S }
}

func Describe[T IShape](x T) float64 { return x.Area() }

func Main() {
    Console.WriteLine(Describe[Sq](Sq{S: 3.0}))
}`
        let output = CompileAndRun(source)
        Assert.Equal("9${Environment.NewLine}", output)
    }

    @Fact
    func Library_NonSealedUserInterfaceConstraint_PassesIlVerify() {
        // ilverify is invoked unconditionally by CompileLibrary; a missing
        // GenericParamConstraint row or a bare (un-constrained) callvirt would
        // fail verification here.
        let source = `package p

interface IShape { func Area() float64; }

struct Sq : IShape {
    var S float64
    func Area() float64 { return S * S }
}

func Describe[T IShape](x T) float64 { return x.Area() }`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func EndToEnd_SelfReferentialUserGenericInterfaceConstraint_Verifies() {
        // The `[T ICmp[T]]` shape over a user-declared generic interface.
        let source = `package p
import System

interface ICmp[T] { func CompareTo(other T) int32; }

struct Num : ICmp[Num] {
    var V int32
    func CompareTo(other Num) int32 { return V - other.V }
}

func Bigger[T ICmp[T]](a T, b T) int32 { return a.CompareTo(b) }

func Main() {
    Console.WriteLine(Bigger[Num](Num{V: 7}, Num{V: 3}))
}`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}", output)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1052_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            RunCompiler(args)
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1052_exe_").FullName
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
