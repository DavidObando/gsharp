// <copyright file="Issue1066InheritedInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1066: a leaf class satisfies an interface member when the member is
/// implemented (or inherited) anywhere in its base-class chain, even when the
/// interface is reached through interface inheritance (`IDerived : IBase`)
/// or re-stated on a derived class. These tests give end-to-end CLR emit +
/// ilverify coverage and confirm the inherited implementation dispatches
/// correctly at runtime when invoked through an interface-typed reference.
open class Issue1066InheritedInterfaceEmitTests {
    @Fact
    func EndToEnd_InterfaceMethodInheritedFromBase_DispatchesThroughInterfaceReference() {
        // Leaf (→ Mid → Base) satisfies IBase.M via Base's implementation and is
        // attached to IBase through IDerived : IBase. Calling M() through an
        // IBase-typed parameter must resolve the inherited implementation.
        let source = `package p
interface IBase { func M() int32; }
interface IDerived : IBase { }
open class Base : IBase {
    func M() int32 { return 7 }
}
open class Mid : Base { init() { } }
class Leaf : Mid, IDerived { init() { } }
func Get(x IBase) int32 { return x.M() }
func Main() { System.Console.WriteLine(Get(Leaf())) }`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func Library_InterfacePropertyInheritedFromBase_PassesIlVerify() {
        // The canonical issue repro: IBase requires `prop H`, Base implements it,
        // and Leaf reaches IBase through IDerived. ilverify (invoked by
        // CompileLibrary) confirms the emitted assembly is verifiable.
        let source = `package p
interface IBase { prop H int32 { get; } }
interface IDerived : IBase { }
open class Base : IBase {
    prop H int32 { get; init; }
    init(h int32) { H = h }
}
open class Mid : Base { init(h int32) : base(h) { } }
class Leaf : Mid, IDerived { init(h int32) : base(h) { } }`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func Library_InterfaceOnDerivedSatisfiedByImmediateBase_PassesIlVerify() {
        // Requirement coming from a directly-listed interface implemented by a
        // base class.
        let source = `package p
interface IBase { func M() int32; }
open class Base {
    func M() int32 { return 3 }
}
class Leaf : Base, IBase { init() { } }`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1066_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            RunCompiler(args)
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1066_exe_").FullName
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
