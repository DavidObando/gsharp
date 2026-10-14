// <copyright file="Issue1104BasePropertyAccessEmitTests.cs" company="GSharp">
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

/// Issue #1104: end-to-end CLR emit + ilverify coverage for base-class
/// property access `base.Prop` (read), `base.Prop = value` (write),
/// and the explicit-ancestor bracketed form `base[BaseClass].Prop`.
/// Validates the non-virtual `call instance R BaseClass::get_Prop()`
/// / `... BaseClass::set_Prop(value)` shape (NOT `callvirt`), correct
/// runtime behavior (the selected base accessor runs, no infinite recursion
/// through the derived override, and `base[GrandParent]` skips the
/// immediate base's override), and that ilverify accepts the produced assembly.
open class Issue1104BasePropertyAccessEmitTests {
    @Fact
    func EndToEnd_BaseDotProperty_Read_RunsBaseGetter() {
        let source = `package Probe
import System

open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Deriv() : Base {
    override prop RenderSize int64 {
        get { return base.RenderSize + 5L }
    }
}

func Main() {
    var d = Deriv()
    Console.WriteLine(d.RenderSize)
}`
        let output = CompileAndRun(source)
        // base.RenderSize == 10 (base getter, no recursion), override adds 5 → 15.
        Assert.Equal("15${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseDotProperty_ReachesGrandparentGetter() {
        let source = `package Probe
import System

open class A {
    open prop Tag int64 {
        get { return 1L }
    }
}

open class B() : A {
}

open class C() : B {
    override prop Tag int64 {
        get { return base.Tag + 40L }
    }
}

func Main() {
    var c = C()
    Console.WriteLine(c.Tag)
}`
        let output = CompileAndRun(source)
        // B does not override Tag, so base.Tag resolves to A::get_Tag == 1.
        Assert.Equal("41${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseDotProperty_Write_RunsBaseSetter() {
        let source = `package Probe
import System

open class Base {
    var stored int64 = 100L
    open prop Stored int64 {
        get { return stored }
        set { stored = value }
    }
}

open class Deriv() : Base {
    func SetBase(v int64) {
        base.Stored = v
    }
    func ReadBase() int64 {
        return base.Stored
    }
}

func Main() {
    var d = Deriv()
    Console.WriteLine(d.ReadBase())
    d.SetBase(42L)
    Console.WriteLine(d.ReadBase())
}`
        let output = CompileAndRun(source)
        // Initial base.Stored == 100; after base.Stored = 42 it reads back 42.
        Assert.Equal("100${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BracketedBaseProperty_Read_ReachesSpecificAncestor() {
        let source = `package Probe
import System

open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Mid() : Base {
    override prop RenderSize int64 {
        get { return 99L }
    }
}

open class Deriv() : Mid {
    func Probe() int64 {
        return base[Base].RenderSize + base.RenderSize
    }
}

func Main() {
    var d = Deriv()
    Console.WriteLine(d.Probe())
}`
        let output = CompileAndRun(source)
        // base[Base].RenderSize == 10 (grandparent, non-virtual) and
        // base.RenderSize == 99 (immediate base Mid) → 109.
        Assert.Equal("109${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BracketedBaseProperty_Write_RunsSpecificAncestorSetter() {
        let source = `package Probe
import System

open class Base {
    var stored int64 = 100L
    open prop Stored int64 {
        get { return stored }
        set { stored = value }
    }
}

open class Mid() : Base {
}

open class Deriv() : Mid {
    func SetBase(v int64) {
        base[Base].Stored = v
    }
    func ReadBase() int64 {
        return base[Base].Stored
    }
}

func Main() {
    var d = Deriv()
    Console.WriteLine(d.ReadBase())
    d.SetBase(42L)
    Console.WriteLine(d.ReadBase())
}`
        let output = CompileAndRun(source)
        // Initial base[Base].Stored == 100; after the write it reads back 42.
        Assert.Equal("100${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func Library_BaseDotProperty_PassesIlVerify_AndUsesCallNotCallvirt() {
        let source = `package Probe

open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Deriv() : Base {
    override prop RenderSize int64 {
        get { return base.RenderSize }
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            // Find Deriv::get_RenderSize — the override getter that contains the
            // base property read.
            var derivGetter MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "Deriv") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "get_RenderSize") {
                        derivGetter = mh
                    }
                }
            }
            Assert.True((derivGetter != nil), "expected to find Deriv::get_RenderSize")
            let method = reader.GetMethodDefinition(derivGetter!!)
            Assert.True(method.RelativeVirtualAddress != 0, "Deriv::get_RenderSize must carry a body")
            let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
            let ilBytes[]?uint8 = body.GetILBytes()
            Assert.NotNull(ilBytes)
            // ECMA-335 opcodes: `call` = 0x28; `callvirt` = 0x6F. The override
            // getter body's only call is the base property read, which MUST be a
            // non-virtual `call` (a `callvirt` would re-dispatch into
            // Deriv::get_RenderSize and stack-overflow).
            var sawCall = false
            var sawCallvirt = false
            for var i = 0; i < ilBytes!!.Length; i++ {
                if ilBytes!![i] == uint8(0x28) {
                    sawCall = true
                } else if ilBytes!![i] == uint8(0x6F) {
                    sawCallvirt = true
                }
            }
            Assert.True(sawCall, "Deriv::get_RenderSize must contain a `call` opcode (non-virtual base property read)")
            Assert.False(
                sawCallvirt,
                "Deriv::get_RenderSize must NOT use `callvirt` for base.Prop — it would re-enter the override"
            )
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func Library_BracketedBaseProperty_PassesIlVerify_AndUsesCallNotCallvirt() {
        let source = `package Probe

open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Deriv() : Base {
    override prop RenderSize int64 {
        get { return base[Base].RenderSize }
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            // Find Deriv::get_RenderSize — the override getter that contains the
            // bracketed base property read.
            var derivGetter MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "Deriv") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "get_RenderSize") {
                        derivGetter = mh
                    }
                }
            }
            Assert.True((derivGetter != nil), "expected to find Deriv::get_RenderSize")
            let method = reader.GetMethodDefinition(derivGetter!!)
            Assert.True(method.RelativeVirtualAddress != 0, "Deriv::get_RenderSize must carry a body")
            let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
            let ilBytes[]?uint8 = body.GetILBytes()
            Assert.NotNull(ilBytes)
            // ECMA-335 opcodes: `call` = 0x28; `callvirt` = 0x6F. The override
            // getter body's only call is the bracketed base property read, which
            // MUST be a non-virtual `call` (a `callvirt` would re-dispatch into
            // Deriv::get_RenderSize and stack-overflow).
            var sawCall = false
            var sawCallvirt = false
            for var i = 0; i < ilBytes!!.Length; i++ {
                if ilBytes!![i] == uint8(0x28) {
                    sawCall = true
                } else if ilBytes!![i] == uint8(0x6F) {
                    sawCallvirt = true
                }
            }
            Assert.True(
                sawCall,
                "Deriv::get_RenderSize must contain a `call` opcode (non-virtual bracketed base property read)"
            )
            Assert.False(
                sawCallvirt,
                "Deriv::get_RenderSize must NOT use `callvirt` for base[Base].Prop — it would re-enter the override"
            )
        } finally {
            TryCleanup(dllPath)
        }
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_bpa_lib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_bpa_exe_").FullName
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
