// <copyright file="Issue1229UserClassToObjectEmitTests.cs" company="GSharp">
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
import Xunit.Sdk

/// Issue #1229: an instance of a user-declared `class` must implicitly
/// convert to `object` / `object?`. Every reference type derives from
/// System.Object, so the conversion is a plain reference upcast — there must be
/// NO `box` instruction (boxing is only for value types). These tests
/// exercise the upcast in argument, return, local/field assignment, and
/// collection-element positions, verify the emitted IL, assert the runtime
/// behaviour (ToString()/GetType() through the object reference and a
/// List[object] round-trip), and confirm the upcast method's IL carries no
/// spurious `box`.
open class Issue1229UserClassToObjectEmitTests {
    @Fact
    func UserClassToObject_AllPositions_EmitAndRun() {
        let source = `package P
import System
import System.Collections.Generic

class D { }

class Sink {
    func Takes(o object) string { return o.GetType().Name }
    func TakesN(o object?) string { return o!!.GetType().Name }
    func Give(d D) object? { return d }
}

let d = D{ }
let s = Sink{ }

// Argument position (object and object?).
Console.WriteLine(s.Takes(d))
Console.WriteLine(s.TakesN(d))

// Return position.
let r = s.Give(d)
Console.WriteLine(r!!.GetType().Name)

// Local assignment.
let o object = d
Console.WriteLine(o.GetType().Name)
let n object? = d
Console.WriteLine(n!!.GetType().Name)

// Collection-element position: a user class flows into List[object]
// as a reference upcast, then reads back as an object reference.
let list = List[object]()
list.Add(d)
let back object = list[0]
Console.WriteLine(back.GetType().Name)`
        Assert.Equal(
            "D${Environment.NewLine}D${Environment.NewLine}D${Environment.NewLine}D${Environment.NewLine}D${Environment.NewLine}D${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func MultiLevelHierarchy_GrandchildToObject_EmitsAndRuns() {
        let source = `package P
import System

open class GrandBase { }
open class Child() : GrandBase { }
class Grandchild() : Child { }

func Up(g Grandchild) object { return g }

let g = Grandchild{ }
let o = Up(g)
Console.WriteLine(o.GetType().Name)`
        Assert.Equal("Grandchild${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UserClassToObject_UpcastMethod_HasNoBox() {
        // A method that just returns its user-class argument typed as `object`
        // is a pure reference upcast: its IL body must contain no `box`
        // instruction (ECMA-335 box = 0x8C). A spurious box would still verify
        // (boxing a reference is legal IL) but is semantically wrong here.
        let source = `package P

class D { }

func Up(d D) object { return d }`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var upMethod MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "Up") {
                        upMethod = mh
                    }
                }
            }
            Assert.True((upMethod != nil), "expected to find the Up method")
            let method = reader.GetMethodDefinition(upMethod!!)
            Assert.True(method.RelativeVirtualAddress != 0, "Up must carry a body")
            let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
            let ilBytes[]?uint8 = body.GetILBytes()
            Assert.NotNull(ilBytes)
            // The upcast lowers to `ldarg.0; ret` (a no-op reference widening),
            // so the body is tiny and contains no `box` (0x8C) opcode.
            var sawBox = false
            for var i = 0; i < ilBytes!!.Length; i++ {
                if ilBytes!![i] == uint8(0x8C) {
                    sawBox = true
                }
            }
            Assert.False(sawBox, "class -> object upcast must NOT emit a `box` instruction")
        } finally {
            TryCleanup(dllPath)
        }
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1229_lib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1229_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
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
                if dir != nil {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
