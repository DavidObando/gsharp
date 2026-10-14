// <copyright file="Issue987AbstractMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.Globalization
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #987: end-to-end CLR emit + ilverify coverage for abstract members. A
/// no-body `open func F() R;` on an `open class` is the canonical G#
/// spelling of a C# `abstract` method. Validates that the original GS9998
/// emit ICE is gone, that the declaring type is emitted with
/// `TypeAttributes.Abstract` and the method with
/// `MethodAttributes.Abstract | Virtual | NewSlot` (no IL body), that a
/// concrete override makes the type constructible with working virtual
/// dispatch, and that the GS0386 (cannot instantiate abstract type) and GS0387
/// (concrete class missing an inherited abstract override) diagnostics fire.
open class Issue987AbstractMethodEmitTests {
    @Fact
    func AbstractMethod_ReproCompiles_TypeAndMethodAreAbstract() {
        let source = `package T
open class Shape {
    open func Area() float64;
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var shape TypeDefinition? = nil
            for th in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(th)
                if reader.StringComparer.Equals(td.Name, "Shape") {
                    shape = td
                }
            }
            Assert.True((shape != nil), "expected to find type Shape")
            Assert.True(
                shape!!.Attributes.HasFlag(TypeAttributes.Abstract),
                "Shape must be emitted with TypeAttributes.Abstract"
            )
            Assert.False(shape!!.Attributes.HasFlag(TypeAttributes.Sealed), "an abstract class must not be Sealed")
            var area MethodDefinition? = nil
            for mh in shape!!.GetMethods() {
                let md = reader.GetMethodDefinition(mh)
                if reader.StringComparer.Equals(md.Name, "Area") {
                    area = md
                }
            }
            Assert.True((area != nil), "expected to find Shape::Area")
            Assert.True(area!!.Attributes.HasFlag(MethodAttributes.Abstract), "Area must be Abstract")
            Assert.True(area!!.Attributes.HasFlag(MethodAttributes.Virtual), "Area must be Virtual")
            Assert.True(area!!.Attributes.HasFlag(MethodAttributes.NewSlot), "Area must be NewSlot")
            Assert.False(area!!.Attributes.HasFlag(MethodAttributes.Final), "an abstract method must not be Final")
            Assert.True(area!!.RelativeVirtualAddress == 0, "an abstract method must carry no IL body")
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func EndToEnd_ConcreteOverride_PrintsAreaViaVirtualDispatch() {
        let source = `package T
import System
open class Shape { open func Area() float64; }
class Circle(R float64) : Shape { override func Area() float64 { return 3.14159 * R * R } }
let s Shape = Circle(2.0)
Console.WriteLine(s.Area().ToString())`
        let output = CompileAndRun(source)
        let first = output.ReplaceLineEndings(Environment.NewLine).Split(Environment.NewLine)[0]
        let value = float64.Parse(first, CultureInfo.InvariantCulture)
        Assert.True(Math.Abs(value - 12.566) < 0.01, "expected area ≈ 12.566 via virtual dispatch but got $value")
    }

    @Fact
    func ConstructingAbstractType_FailsWithGS0386() {
        let source = `package T
open class Shape { open func Area() float64; }
let bad = Shape()`
        let (exit, stdout) = TryCompileLibrary(source)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0386", stdout)
    }

    @Fact
    func ConcreteDerivedMissingOverride_FailsWithGS0387() {
        let source = `package T
open class Shape { open func Area() float64; }
class Circle(R float64) : Shape { }`
        let (exit, stdout) = TryCompileLibrary(source)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0387", stdout)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_abs_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            let (exit, stdout, stderr) = RunGsc(args)
            Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func TryCompileLibrary(source string)(Exit int32, Stdout string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_abs_neg_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                let (exit, stdout, _) = RunGsc(args)
                return (exit, stdout)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func RunGsc(args[]string)(Exit int32, Stdout string, Stderr string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var exit int32
            try {
                exit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (exit, stdoutWriter.ToString(), stderrWriter.ToString())
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_abs_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                let (exit, stdout, stderr) = RunGsc(args)
                Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
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
                let procOut = proc.StandardOutput.ReadToEnd()
                let procErr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$procOut" + `
stderr:
` + "$procErr"))
                return procOut.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
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
