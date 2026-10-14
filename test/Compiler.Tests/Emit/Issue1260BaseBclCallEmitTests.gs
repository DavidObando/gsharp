// <copyright file="Issue1260BaseBclCallEmitTests.cs" company="GSharp">
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

/// Issue #1260: end-to-end CLR emit + ilverify coverage for `base.Member(...)`
/// and `base.Prop` accesses into an <b>imported / BCL</b> base class (e.g.
/// (cref:object.ToString), `System.IO.Stream.Dispose(bool)` via
/// (cref:System.IO.MemoryStream)). Before the fix the binder rejected
/// these with GS0383 because the GSharp class had no user `StructSymbol`
/// base. Validates the non-virtual `call` shape (NOT `callvirt`, which
/// would re-enter the derived override and recurse), correct runtime behavior,
/// multi-level chains, and that ilverify accepts the produced assembly.
open class Issue1260BaseBclCallEmitTests {
    @Fact
    func EndToEnd_BaseObjectToString_RunsBaseImplementation() {
        let source = `package Probe
import System

class Greeter {
    // Issue #1354: object.ToString() is annotated to return string?,
    // so base.ToString() is nullable here and must be coalesced
    // before concatenation.
    open func ToString() string { return (base.ToString() ?? "") + "!" }
}

func Main() {
    var g = Greeter()
    Console.WriteLine(g.ToString())
}`
        let output = CompileAndRun(source)
        // base.ToString() delegates to object.ToString() (the type's full name),
        // then the override appends "!". The key assertion is that no infinite
        // recursion occurs and the suffix is present.
        Assert.Equal("Probe.Greeter!${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseStreamDispose_RunsWithoutError() {
        let source = `package Probe
import System
import System.IO

class MyMem : MemoryStream {
    open func Dispose(disposing bool) {
        Console.WriteLine("disposing=" + disposing.ToString())
        base.Dispose(disposing)
    }
}

func Main() {
    var m = MyMem()
    m.Dispose(true)
    Console.WriteLine("done")
}`
        let output = CompileAndRun(source)
        // The virtual-with-body base Dispose(bool) runs and returns; no recursion.
        Assert.Equal("disposing=True${Environment.NewLine}done${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_MultiLevel_UserBaseThenBcl_ResolvesToBcl() {
        let source = `package Probe
import System
import System.IO

open class Wrapper : MemoryStream { }

class MyMem : Wrapper {
    open func Dispose(disposing bool) {
        base.Dispose(disposing)
        Console.WriteLine("after-base")
    }
}

func Main() {
    var m = MyMem()
    m.Dispose(true)
}`
        // The nearest user base (Wrapper) does not declare Dispose(bool); the
        // base call resolves up to MemoryStream.Dispose(bool).
        let output = CompileAndRun(source)
        Assert.Equal("after-base${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseBclProperty_ReadAndWrite() {
        let source = `package Probe
import System
import System.IO

class MyMem : MemoryStream {
    func RoundTrip() int64 {
        base.Position = 0
        return base.Position
    }
}

func Main() {
    var m = MyMem()
    Console.WriteLine(m.RoundTrip().ToString())
}`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func Library_BaseBclCall_PassesIlVerify_AndUsesCallNotCallvirt() {
        let source = `package Probe
import System.IO

class MyMem : MemoryStream {
    open func Dispose(disposing bool) {
        base.Dispose(disposing)
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var disposeHandle MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "MyMem") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "Dispose") {
                        disposeHandle = mh
                    }
                }
            }
            Assert.True((disposeHandle != nil), "expected to find MyMem::Dispose")
            let method = reader.GetMethodDefinition(disposeHandle!!)
            Assert.True(method.RelativeVirtualAddress != 0, "MyMem::Dispose must carry a body")
            let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
            let ilBytes[]?uint8 = body.GetILBytes()
            Assert.NotNull(ilBytes)
            // ECMA-335 opcodes: `call` = 0x28; `callvirt` = 0x6F. The base call
            // into the BCL base MUST be a non-virtual `call` (a `callvirt` would
            // re-dispatch into MyMem::Dispose and stack-overflow).
            var sawCall = false
            var sawCallvirt = false
            for var i = 0; i < ilBytes!!.Length; i++ {
                if ilBytes!![i] == uint8(0x28) {
                    sawCall = true
                } else if ilBytes!![i] == uint8(0x6F) {
                    sawCallvirt = true
                }
            }
            Assert.True(sawCall, "MyMem::Dispose must contain a `call` opcode (non-virtual base BCL call)")
            Assert.False(
                sawCallvirt,
                "MyMem::Dispose must NOT use `callvirt` for base.Dispose() — it would re-enter the override"
            )
        } finally {
            TryCleanup(dllPath)
        }
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_bcl_lib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_bcl_exe_").FullName
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
                TryCleanup(tempDir)
            }
        }

        private func TryCleanup(path string) {
            try {
                if Directory.Exists(path) {
                    Directory.Delete(path, recursive: true)
                } else if File.Exists(path) {
                    let dir string? = Path.GetDirectoryName(path)
                    if dir != nil && Directory.Exists(dir) {
                        Directory.Delete(dir, recursive: true)
                    }
                }
            } catch {
                // Best-effort cleanup.

            }
        }
    }
}
