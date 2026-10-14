// <copyright file="Issue2181GenericExplicitInterfaceImplEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #2181 (follow-up to #2010): a method using the reserved
/// `__explicit_<Interface>__<Member>` mangled convention
/// correctly satisfied a NON-generic interface member, but was not recognized
/// when the interface was GENERIC — the class was wrongly reported as not
/// implementing the interface method (GS0187). ADR-0149 later replaced the
/// mangled convention with the `func (InterfaceType) Member(...)`
/// qualifier clause this test now exercises; the underlying generic-interface
/// fixes below remain in effect for the new syntax too.
///
/// Two defects were fixed. (1) The binder-side interface-target resolution
/// must match a clause's bound type against the SAME (canonical) instance
/// already recorded in the implementer's `StructSymbol.Interfaces` —
/// structurally, not just by reference — since a constructed generic
/// interface (`ICallback[T, TResult]`) is not interned; two independent
/// bindings of the same constructed interface are different object
/// instances. (2) The emitter's `EmitExplicitInterfaceMethodImpls`
/// looked for the linked interface member on the interface DEFINITION's
/// method table, but for a constructed generic interface the linked member is
/// the SUBSTITUTED instance on the constructed interface — so no
/// `MethodImpl` row was emitted and the type failed to load. The emitter
/// now matches the constructed instance's methods and maps back to the open
/// slot for token resolution.
///
/// The non-generic path (issue #2010) is intentionally unchanged.
open class Issue2181GenericExplicitInterfaceImplEmitTests {
    @Fact
    func GenericExplicitImpl_Compiles_EmitsMethodImplRow_IlVerifies() {
        let dllPath = CompileLibrary(GenericReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var callback = default(TypeDefinition)
            var foundCallback = false
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if reader.GetString(td.Name).StartsWith("Callback", StringComparison.Ordinal) && reader.GetString(
                    td.Name
                ) != "Callback2" {
                    callback = td
                    foundCallback = true
                    break
                }
            }
            Assert.True(foundCallback, "expected to find the generic Callback type")
            // ADR-0149: the explicit-impl body survives as its own MethodDef,
            // under its synthesized (collision-free) metadata name
            // ("<Package>.<Interface>[<TypeParams>].<Member>" — the OPEN
            // generic interface's own type-parameter names, since this
            // clause is declared directly on the open generic class).
            let explicitBodies = callback
                .GetMethods()
                .Select((mh MethodDefinitionHandle) -> reader.GetString(reader.GetMethodDefinition(mh).Name))
                .Count((n string) -> n == "Oahu.Aux.ICallback[T, TResult].Interact")
            Assert.Equal(1, explicitBodies)
            // Issue #2181: a MethodImpl row must bind the explicit body to the
            // (generic) interface's Interact slot — without it the type fails
            // to load at runtime with a TypeLoadException.
            let methodImplRows = callback.GetMethodImplementations().Count()
            Assert.Equal(1, methodImplRows)
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func GenericExplicitImpl_DispatchesThroughConstructedInterface() {
        // End-to-end: an ICallback[int32, int32]-typed reference routes into
        // the mangled explicit implementation, which forwards to the overriding
        // OnInteract body (value * 2). Proves the constructed-generic slot is
        // wired up at the CLR level.
        let source = GenericReproSource + `

var obj = Doubler{}
var cb ICallback[int32, int32] = obj
Console.WriteLine(cb.Interact(21))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NonGenericExplicitImpl_StillCompilesAndDispatches() {
        // Regression guard: the issue #2010 non-generic path is unchanged.
        let source = NonGenericReproSource + `

var obj = Callback2{}
var cb ICallback2 = obj
Console.WriteLine(cb.Interact(7))`
        Assert.Equal("base${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private const GenericReproSource string = `package Oahu.Aux

interface ICallback[T, TResult] {
    func Interact(value T) TResult;
}

open class Callback[T, TResult] : ICallback[T, TResult] {
    private func (ICallback[T, TResult]) Interact(value T) TResult -> OnInteract(value)

    protected open func OnInteract(value T) TResult {
        return default(TResult)
    }
}

open class Doubler : Callback[int32, int32] {
    protected override func OnInteract(value int32) int32 {
        return value * 2
    }
}`

        private const NonGenericReproSource string = `package Oahu.Aux

interface ICallback2 {
    func Interact(value int32) string;
}

open class Callback2 : ICallback2 {
    private func (ICallback2) Interact(value int32) string -> OnInteract(value)

    protected open func OnInteract(value int32) string {
        return "base"
    }
}`

        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2181_lib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2181_exe_").FullName
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
