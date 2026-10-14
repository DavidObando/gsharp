// <copyright file="Issue1347BaseAutoPropertyReadEmitTests.cs" company="GSharp">
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

/// Issue #1347: end-to-end CLR emit + ilverify coverage for reading and writing
/// a base-class <em>auto-property</em> through `base.Prop`. An
/// auto-property has no accessor (cref:GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol)
/// — its getter/setter are compiler-synthesized over a backing field — and the
/// original #1104 support mis-bound such a read as a write (GS0127). These tests
/// validate that the read/write now lower to the non-virtual
/// `call instance R BaseClass::get_Prop()` / `... set_Prop(value)`
/// shape (NOT `callvirt`, which would re-enter the derived override and
/// stack-overflow), produce the correct runtime values, and pass ilverify.
open class Issue1347BaseAutoPropertyReadEmitTests {
    @Fact
    func EndToEnd_BaseDotAutoProperty_Read_RunsSynthesizedGetter() {
        let source = `package Probe
import System

open class Base {
    prop Stored int64 { get; init; }
}

open class Deriv : Base {
    func ReadBase() int64 {
        return base.Stored
    }
}

func Main() {
    var d = Deriv{Stored: 17L}
    Console.WriteLine(d.ReadBase())
}`
        let output = CompileAndRun(source)
        Assert.Equal("17${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseDotAutoProperty_ExpressionBodiedReExposure_Reads() {
        // The Oahu.Decrypt DashFile shape: a derived expression-bodied member
        // re-exposing the base auto-property (`prop Mirror T -> base.Stored`).
        let source = `package Probe
import System

open class Base {
    prop Stored int64 { get; init; }
}

open class Deriv : Base {
    prop Mirror int64 -> base.Stored
}

func Main() {
    var d = Deriv{Stored: 23L}
    Console.WriteLine(d.Mirror)
}`
        let output = CompileAndRun(source)
        Assert.Equal("23${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseDotAutoProperty_Write_RunsSynthesizedSetter() {
        let source = `package Probe
import System

open class Base {
    prop Stored int64 { get; set; }
}

open class Deriv : Base {
    func SetBase(v int64) {
        base.Stored = v
    }
    func ReadBase() int64 {
        return base.Stored
    }
}

func Main() {
    var d = Deriv{Stored: 100L}
    Console.WriteLine(d.ReadBase())
    d.SetBase(42L)
    Console.WriteLine(d.ReadBase())
}`
        let output = CompileAndRun(source)
        Assert.Equal("100${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseDotAutoProperty_ReachesGrandparentGetter() {
        let source = `package Probe
import System

open class A {
    prop Tag int64 { get; init; }
}

open class B : A {
}

open class C : B {
    func Read() int64 {
        return base.Tag
    }
}

func Main() {
    var c = C{Tag: 5L}
    Console.WriteLine(c.Read())
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func Library_BaseDotAutoProperty_PassesIlVerify_AndUsesCallNotCallvirt() {
        let source = `package Probe

open class Base {
    prop Stored int64 { get; init; }
}

open class Deriv : Base {
    prop Mirror int64 -> base.Stored
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            // Find Deriv::get_Mirror — the expression-bodied getter that
            // contains the base auto-property read.
            var mirrorGetter MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "Deriv") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "get_Mirror") {
                        mirrorGetter = mh
                    }
                }
            }
            Assert.True((mirrorGetter != nil), "expected to find Deriv::get_Mirror")
            let method = reader.GetMethodDefinition(mirrorGetter!!)
            Assert.True(method.RelativeVirtualAddress != 0, "Deriv::get_Mirror must carry a body")
            let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
            let ilBytes[]?uint8 = body.GetILBytes()
            Assert.NotNull(ilBytes)
            // ECMA-335 opcodes: `call` = 0x28; `callvirt` = 0x6F. The base
            // auto-property read MUST be a non-virtual `call` to the
            // synthesized base get_Stored.
            var sawCall = false
            var sawCallvirt = false
            for var i = 0; i < ilBytes!!.Length; i++ {
                if ilBytes!![i] == uint8(0x28) {
                    sawCall = true
                } else if ilBytes!![i] == uint8(0x6F) {
                    sawCallvirt = true
                }
            }
            Assert.True(sawCall, "Deriv::get_Mirror must contain a `call` opcode (non-virtual base auto-property read)")
            Assert.False(sawCallvirt, "Deriv::get_Mirror must NOT use `callvirt` for base.Stored")
        } finally {
            TryCleanup(dllPath)
        }
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_bap_lib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_bap_exe_").FullName
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
