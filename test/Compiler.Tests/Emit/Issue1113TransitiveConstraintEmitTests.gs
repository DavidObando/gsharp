// <copyright file="Issue1113TransitiveConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1113: a generic interface constraint (`[T IFace]`) must be
/// satisfied when the type argument implements the interface ANYWHERE in its
/// hierarchy — directly, through a base class, or via a transitively-inherited
/// base interface (mirrors C#'s `where T : IFace`). Before the fix only
/// interfaces directly declared on the type argument were considered, so a class
/// inheriting the interface through its base class was wrongly rejected with
/// GS0152. These tests compile, ilverify, and RUN the repro to prove dispatch
/// through the inherited constraint works at runtime.
open class Issue1113TransitiveConstraintEmitTests {
    @Fact
    func EndToEnd_InterfaceInheritedFromBaseClass_SatisfiesConstraintAndDispatches() {
        // FreeBox inherits IBox via its base class Box (does NOT re-declare it).
        let source = `package p
interface IBox { func F() int32; }
open class Box : IBox { func F() int32 { return 1 } }
class FreeBox : Box { }
class Helper {
    func Use[T IBox](x T) int32 { return x.F() }
    func Call() int32 { return Use(FreeBox()) }
}
func Main() { System.Console.WriteLine(Helper().Call()) }`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_InterfaceInheritedFromGrandparent_SatisfiesConstraintAndDispatches() {
        // Two-level base chain: the grandparent declares the interface; the
        // intermediate and leaf classes only inherit it.
        let source = `package p
interface IBox { func F() int32; }
open class Box : IBox { func F() int32 { return 7 } }
open class MidBox : Box { }
class LeafBox : MidBox { }
class Helper {
    func Use[T IBox](x T) int32 { return x.F() }
    func Call() int32 { return Use(LeafBox()) }
}
func Main() { System.Console.WriteLine(Helper().Call()) }`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DirectImplementer_StillSatisfiesConstraint() {
        // Positive regression: the direct-implementer case must keep working.
        let source = `package p
interface IBox { func F() int32; }
open class Box : IBox { func F() int32 { return 3 } }
class Helper {
    func Use[T IBox](x T) int32 { return x.F() }
    func Call() int32 { return Use(Box()) }
}
func Main() { System.Console.WriteLine(Helper().Call()) }`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func Library_InheritedInterfaceConstraint_PassesIlVerify() {
        // ilverify is invoked unconditionally by CompileLibrary; a missing
        // GenericParamConstraint row or a bare callvirt on the unboxed type
        // parameter would fail verification here.
        let source = `package p
interface IBox { func F() int32; }
open class Box : IBox { func F() int32 { return 1 } }
class FreeBox : Box { }
class Helper {
    func Use[T IBox](x T) int32 { return x.F() }
    func Call() int32 { return Use(FreeBox()) }
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1113_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            RunCompiler(args)
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1113_exe_").FullName
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
