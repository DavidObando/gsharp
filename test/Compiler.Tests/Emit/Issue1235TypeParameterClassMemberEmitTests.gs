// <copyright file="Issue1235TypeParameterClassMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1235: end-to-end CLR emit + ilverify coverage for instance FIELD and
/// PROPERTY access on a value whose static type is a type parameter constrained
/// to a (user) class or interface. Methods already dispatched through the
/// constraint (issue #1056); these tests validate that fields, (inherited)
/// properties, and interface properties are surfaced too, that the emitted
/// `box !!T; ldfld` / `box !!T; callvirt get_X` sequences pass
/// ilverify, and that the reads return the right values at runtime.
open class Issue1235TypeParameterClassMemberEmitTests {
    @Fact
    func EndToEnd_ClassConstraint_ReadsFieldPropertyMethodAndInherited() {
        let source = `package p
open class GrandBase { prop Inherited int32 { get; set; } }
open class Base : GrandBase {
  prop P int32 { get; set; }
  var F2 int32
  func Hello() int32 { return 42 }
}
open class C[T Base] {
  func ReadProp(t T) int32 { return t.P }
  func ReadField(t T) int32 { return t.F2 }
  func CallMethod(t T) int32 { return t.Hello() }
  func ReadInherited(t T) int32 { return t.Inherited }
}
func Main() {
  var b = Base()
  b.P = 7
  b.F2 = 13
  b.Inherited = 100
  var c = C[Base]()
  var sum = c.ReadProp(b) + c.ReadField(b) + c.CallMethod(b) + c.ReadInherited(b)
  System.Console.WriteLine(sum)
}`
        let output = CompileAndRun(source)
        Assert.Equal("162${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_InterfaceConstraint_ReadsProperty() {
        let source = `package p
interface IHasName { prop Name int32 { get; } }
open class Named : IHasName { prop Name int32 { get; set; } }
open class D[T IHasName] {
  func ReadIfaceProp(t T) int32 { return t.Name }
}
func Main() {
  var n = Named()
  n.Name = 55
  var d = D[Named]()
  System.Console.WriteLine(d.ReadIfaceProp(n))
}`
        let output = CompileAndRun(source)
        Assert.Equal("55${Environment.NewLine}", output)
    }

    @Fact
    func Library_ClassConstraintFieldAndPropertyReads_PassIlVerify() {
        // ilverify is invoked unconditionally by CompileLibrary; a bare ldfld /
        // callvirt on the unboxed `!!T` value (missing the `box !!T`) would fail
        // verification here with StackUnexpected.
        let source = `package p
open class Base {
  prop P int32 { get; set; }
  var F2 int32
}
open class C[T Base] {
  func A(t T) int32 { return t.P }
  func B(t T) int32 { return t.F2 }
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1235_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            RunCompiler(args)
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1235_exe_").FullName
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
