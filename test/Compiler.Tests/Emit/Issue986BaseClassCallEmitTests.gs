// <copyright file="Issue986BaseClassCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #986: end-to-end CLR emit + ilverify coverage for the base-class
/// call forms `base.M(...)` and `base[BaseClass].M(...)`. Validates
/// the non-virtual `call instance ... BaseClass::M(...)` shape (NOT
/// `callvirt`), correct runtime behavior (the base implementation runs,
/// no infinite recursion), and that ilverify accepts the produced assembly.
open class Issue986BaseClassCallEmitTests {
    @Fact
    func EndToEnd_BaseDotCall_RunsBaseImplementation() {
        let source = `package Probe
import System

open class Shape {
    open func Describe() string { return "shape" }
}

class Circle() : Shape {
    override func Describe() string { return base.Describe() + " circle" }
}

func Main() {
    var c = Circle()
    Console.WriteLine(c.Describe())
}`
        let output = CompileAndRun(source)
        Assert.Equal("shape circle${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseBracketCall_RunsBaseImplementation() {
        let source = `package Probe
import System

open class Shape {
    open func Describe() string { return "shape" }
}

class Circle() : Shape {
    override func Describe() string { return base[Shape].Describe() + " circle" }
}

func Main() {
    var c = Circle()
    Console.WriteLine(c.Describe())
}`
        let output = CompileAndRun(source)
        Assert.Equal("shape circle${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseCall_WithParametersAndReturn() {
        let source = `package Probe
import System

open class Adder {
    open func Add(a int32, b int32) int32 { return a + b }
}

class LoggingAdder() : Adder {
    override func Add(a int32, b int32) int32 { return base.Add(a, b) + 100 }
}

func Main() {
    var x = LoggingAdder()
    Console.WriteLine(x.Add(2, 3))
}`
        let output = CompileAndRun(source)
        // base.Add(2,3) == 5, override adds 100 → 105.
        Assert.Equal("105${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseCall_ReachesGrandparentImplementation() {
        let source = `package Probe
import System

open class A {
    open func Name() string { return "A" }
}

open class B() : A {
}

class C() : B {
    override func Name() string { return base.Name() + "C" }
}

func Main() {
    var c = C()
    Console.WriteLine(c.Name())
}`
        let output = CompileAndRun(source)
        // B does not override Name, so base.Name() resolves to A::Name.
        Assert.Equal("AC${Environment.NewLine}", output)
    }

    @Fact
    func Issue2534_EndToEnd_BaseCallResultChain_SelectsOverloadAndRuns() {
        let source = `package Probe
import System

open class Formatter {
    open func Format(value int32) string { return "number" }
    open func Format(value string) string { return "text" }
}

class LoudFormatter() : Formatter {
    override func Format(value int32) string {
        return base.Format(value).ToUpperInvariant()
    }
}

func Main() {
    Console.WriteLine(LoudFormatter().Format(1))
}`
        Assert.Equal("NUMBER${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Issue2534_Library_OverloadedBaseCall_UsesCallNotCallvirt() {
        let source = `package Probe

open class Base {
    open func Pick(value int32) string { return "number" }
    open func Pick(value string) string { return "text" }
}

class Derived() : Base {
    override func Pick(value int32) string {
        return base.Pick(value)
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            AssertMethodUsesCallNotCallvirt(dllPath, "Derived", "Pick")
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func Library_BaseDotCall_PassesIlVerify_AndUsesCallNotCallvirt() {
        let source = `package Probe

open class Shape {
    open func Tag() string { return "shape" }
}

class Circle() : Shape {
    override func Tag() string {
        return base.Tag()
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            AssertMethodUsesCallNotCallvirt(dllPath, "Circle", "Tag")
        } finally {
            TryCleanup(dllPath)
        }
    }

    shared {
        private func AssertMethodUsesCallNotCallvirt(dllPath string, typeName string, methodName string) {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var target MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, typeName) {
                    continue
                }
                for methodHandle in td.GetMethods() {
                    let method = reader.GetMethodDefinition(methodHandle)
                    if reader.StringComparer.Equals(method.Name, methodName) {
                        target = methodHandle
                    }
                }
            }
            Assert.True((target != nil), "expected to find $typeName::$methodName")
            let definition = reader.GetMethodDefinition(target!!)
            Assert.True(definition.RelativeVirtualAddress != 0, "$typeName::$methodName must carry a body")
            let ilBytes[]?uint8 = peReader.GetMethodBody(definition.RelativeVirtualAddress).GetILBytes()
            Assert.NotNull(ilBytes)
            Assert.Contains(uint8(0x28), ilBytes!!)
            Assert.DoesNotContain(uint8(0x6F), ilBytes!!)
        }

        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_bcc_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_bcc_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
