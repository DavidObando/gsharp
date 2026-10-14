// <copyright file="Issue757BaseInterfaceCallEmitTests.cs" company="GSharp">
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

/// ADR-0091 / issue #757: end-to-end CLR emit + ilverify coverage for
/// `base[IFoo].M()`. Validates the non-virtual `call instance ...
/// IFoo::M(...)` shape (NOT `callvirt`), the diamond
/// disambiguation runtime behavior, and that ilverify accepts the
/// produced assembly.
open class Issue757BaseInterfaceCallEmitTests {
    @Fact
    func EndToEnd_DiamondDelegation_DelegatesToBothDefaults() {
        let source = `package Probe
import System

interface IA {
    func Tag() string { return "A" }
}

interface IB {
    func Tag() string { return "B" }
}

class C : IA, IB {
    func Tag() string {
        return base[IA].Tag() + base[IB].Tag()
    }
}

func Main() {
    var c = C{}
    Console.WriteLine(c.Tag())
}`
        let output = CompileAndRun(source)
        Assert.Equal("AB${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NonVirtualCall_DoesNotRecurseThroughOverride() {
        // ADR-0091: `base[IGreeter].Hello()` MUST emit `call`, not
        // `callvirt`. If `callvirt` were used the call would re-dispatch
        // through the v-table back into `Loud.Hello` and stack-overflow.
        let source = `package Probe
import System

interface IGreeter {
    func Hello() string { return "default" }
}

class Loud : IGreeter {
    func Hello() string {
        return base[IGreeter].Hello()
    }
}

func Main() {
    var l = Loud{}
    Console.WriteLine(l.Hello())
}`
        let output = CompileAndRun(source)
        Assert.Equal("default${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DiamondDelegation_ThroughInterfaceTypedReceiver() {
        // Diamond + virtual dispatch through interface-typed receiver:
        // the class's override is reached via the v-table, then the
        // override reaches the IA/IB defaults via the non-virtual
        // `call` from ADR-0091.
        let source = `package Probe
import System

interface IA {
    func V() int32 { return 1 }
}

interface IB {
    func V() int32 { return 2 }
}

class C : IA, IB {
    func V() int32 {
        return base[IA].V() + base[IB].V() * 10
    }
}

func Main() {
    var c = C{}
    var ia IA = c
    var ib IB = c
    Console.WriteLine(c.V())
    Console.WriteLine(ia.V())
    Console.WriteLine(ib.V())
}`
        let output = CompileAndRun(source)
        // 1 + 2 * 10 == 21 — all three call-sites converge on C.V via
        // virtual dispatch.
        Assert.Equal("21${Environment.NewLine}21${Environment.NewLine}21${Environment.NewLine}", output)
    }

    @Fact
    func Library_DiamondDisambiguation_PassesIlVerify_AndUsesCallNotCallvirt() {
        // Compile a library version so we can also inspect metadata /
        // method bodies. ilverify is invoked unconditionally by
        // CompileLibrary.
        let source = `package Probe
import System

interface IA {
    func Tag() string { return "A" }
}

interface IB {
    func Tag() string { return "B" }
}

class C : IA, IB {
    func Tag() string {
        return base[IA].Tag() + base[IB].Tag()
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            // Find C::Tag — the override that contains the `call`s.
            var cTag MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "C") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "Tag") {
                        cTag = mh
                    }
                }
            }
            Assert.True((cTag != nil), "expected to find C::Tag")
            let method = reader.GetMethodDefinition(cTag!!)
            Assert.True(method.RelativeVirtualAddress != 0, "C::Tag must carry a body")
            let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
            let ilBytes[]?uint8 = body.GetILBytes()
            Assert.NotNull(ilBytes)
            // ECMA-335 opcodes: `call` = 0x28 (single byte); `callvirt`
            // = 0x6F. The override body must contain `call` to a method
            // reference for the IA/IB default — and must NOT contain a
            // callvirt opcode in the relevant section (the only calls in
            // the body are the two base-interface ones plus string
            // concat; string concat uses `call`, not `callvirt`).
            var sawCall = false
            var sawCallvirt = false
            for var i = 0; i < ilBytes!!.Length; i++ {
                if ilBytes!![i] == uint8(0x28) {
                    sawCall = true
                } else if ilBytes!![i] == uint8(0x6F) {
                    sawCallvirt = true
                }
            }
            Assert.True(sawCall, "C::Tag must contain a `call` opcode (non-virtual base interface call)")
            Assert.False(
                sawCallvirt,
                "C::Tag must NOT use `callvirt` for base[IFoo].M() — it would re-enter the override"
            )
        } finally {
            TryCleanup(dllPath)
        }
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_bic_lib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_bic_exe_").FullName
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
