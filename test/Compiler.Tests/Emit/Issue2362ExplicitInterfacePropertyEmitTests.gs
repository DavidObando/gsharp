// <copyright file="Issue2362ExplicitInterfacePropertyEmitTests.cs" company="GSharp">
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

/// Issue #2362: extends the issue #2010/#2181 explicit-interface-METHOD
/// `func (IFoo) M(...)` qualifier clause (ADR-0149) + CLR
/// `MethodImpl` bridge to PROPERTIES (and, via a collision-drop-only
/// fallback, indexers). A property declared with the `prop (IFoo) P T`
/// qualifier clause is linked by the binder to the specific interface
/// property it implements
/// ((cref:GSharp.Core.CodeAnalysis.Symbols.PropertySymbol.ExplicitInterfaceMember))
/// and the emitter binds a CLR `MethodImpl` row per accessor (getter
/// and/or setter) via `ReflectionMetadataEmitter.EmitExplicitInterfacePropertyMethodImpls`,
/// mirroring `EmitStaticVirtualPropertyMethodImpls` (ADR-0089/#1019). The
/// declared member name stays the plain source name (e.g. `Greeting`)
/// for both the public and explicit property — only the synthesized CLR
/// metadata name (`<Package>.<Interface>.<Member>`,
/// e.g. `GapCheck.IGreeter.Greeting`, and likewise for its
/// `get_`/`set_` accessors) differs, keeping the rows
/// collision-free.
open class Issue2362ExplicitInterfacePropertyEmitTests {
    @Fact
    func GetOnlyExplicitPropertyImpl_Compiles_EmitsMethodImplRow_IlVerifies() {
        let dllPath = CompileLibrary(GetOnlyReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let host = FindType(reader, "Host")
            let getterCount = CountMethodsNamed(reader, host, "GapCheck.IGreeter.get_Greeting")
            Assert.Equal(1, getterCount)
            let methodImplRows = CountMethodImplRows(reader, host)
            Assert.Equal(1, methodImplRows)
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func GetOnlyExplicitPropertyImpl_DispatchesToOwnBodyThroughInterface() {
        let source = GetOnlyReproSource + `

var obj = Host{}
var asIface IGreeter = obj
Console.WriteLine(obj.Greeting)
Console.WriteLine(asIface.Greeting)`
        Assert.Equal("public-hi${Environment.NewLine}explicit-hi${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GetSetExplicitPropertyImpl_Compiles_EmitsTwoMethodImplRows_IlVerifies() {
        let dllPath = CompileLibrary(GetSetReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let counter = FindType(reader, "Counter")
            Assert.Equal(1, CountMethodsNamed(reader, counter, "GapCheck.ICounter.get_Count"))
            Assert.Equal(1, CountMethodsNamed(reader, counter, "GapCheck.ICounter.set_Count"))
            // One MethodImpl row per accessor (getter + setter).
            Assert.Equal(2, CountMethodImplRows(reader, counter))
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func GetSetExplicitPropertyImpl_DispatchesThroughInterface_GetAndSet() {
        let source = GetSetReproSource + `

var obj = Counter{ Count: 5 }
var asIface ICounter = obj
Console.WriteLine(asIface.Count)
asIface.Count = 7
Console.WriteLine(obj.Count)`
        // The explicit getter returns Count * 10 (50); the explicit setter
        // writes straight through to Count (7) — proving both accessors
        // dispatch to the mangled property's own distinct bodies, not the
        // public sibling's.
        Assert.Equal("50${Environment.NewLine}7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericInterfaceExplicitPropertyImpl_Compiles_EmitsMethodImplRow_IlVerifies() {
        let dllPath = CompileLibrary(GenericInterfaceReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let intBox = FindType(reader, "IntBox")
            Assert.Equal(1, CountMethodsNamed(reader, intBox, "GapCheck.IBox[int32].get_Value"))
            Assert.Equal(1, CountMethodImplRows(reader, intBox))
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func OahuProfileShape_Compiles_EmitsFourQualifiedPropertiesAndMethodImplRows_IlVerifies() {
        let dllPath = CompileLibrary(OahuProfileReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let profile = FindType(reader, "Profile")
            Assert.Equal(1, CountMethodsNamed(reader, profile, "Oahu.Core.IProfile.get_Authorization"))
            Assert.Equal(1, CountMethodsNamed(reader, profile, "Oahu.Core.IProfile.get_Token"))
            Assert.Equal(1, CountMethodsNamed(reader, profile, "get_Authorization"))
            Assert.Equal(1, CountMethodsNamed(reader, profile, "get_Token"))
            // Two get-only explicit properties => two MethodImpl rows.
            Assert.Equal(2, CountMethodImplRows(reader, profile))
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func OahuProfileShape_DispatchesToOwnBodiesThroughInterface() {
        let source = OahuProfileReproSource + `

var auth = Authorization{}
var token = Token{}
var obj = Profile{ Authorization: auth, Token: token }
var asIface IProfile = obj
Console.WriteLine(object(asIface.Authorization) == object(auth))
Console.WriteLine(object(asIface.Token) == object(token))`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private const GetOnlyReproSource string = `package GapCheck

interface IGreeter {
    prop Greeting string { get; }
}

class Host : IGreeter {
    prop Greeting string -> "public-hi"

    private prop (IGreeter) Greeting string -> "explicit-hi"
}`

        private const GetSetReproSource string = `package GapCheck

interface ICounter {
    prop Count int32 { get; set; }
}

class Counter : ICounter {
    prop Count int32 { get; set; }

    private prop (ICounter) Count int32 {
        get { return Count * 10 }
        set { Count = value }
    }
}`

        private const GenericInterfaceReproSource string = `package GapCheck

interface IBox[T] {
    prop Value T { get; }
}

class IntBox : IBox[int32] {
    prop Value int32 -> 42

    private prop (IBox[int32]) Value int32 -> 99
}`

        // NOTE: a runtime-dispatch-through-the-interface variant of this test
        // (`var asIface IBox[int32] = obj; Console.WriteLine(asIface.Value)`) was
        // attempted but hits a PRE-EXISTING, unrelated binder gap: member access
        // through a variable typed as a *constructed* generic interface
        // (`IBox[int32]`) fails to resolve (`GS0158: Cannot find member Value`)
        // even with NO explicit interface implementation involved at all. This
        // reproduces identically on a plain `interface IBox[T] { prop Value T {
        // get; } } / class IntBox : IBox[int32] { prop Value int32 -> 42 }` with
        // no mangled member present, so it is unrelated to this fix and is left
        // as a separate, pre-existing, known gap. The IL-level test above still
        // confirms the emitter correctly binds the MethodImpl row for the
        // generic-interface case (mirroring the #2181 generic-method fix), which
        // is the part in scope for #2362.
        /// The exact Oahu `Profile`/`IProfile` shape (see
        /// `src/Oahu.Core/Interfaces.cs` and `src/Oahu.Core/Profile.cs`):
        /// four get-only explicit interface property implementations, each
        /// coexisting with a same-named public concrete property, dispatching
        /// through the interface to their own distinct body. This is the primary
        /// real-world regression this fix addresses.
        private const OahuProfileReproSource string = `package Oahu.Core

class Authorization { }
class Token { }

interface IProfile {
    prop Authorization Authorization { get; }
    prop Token Token { get; }
}

class Profile : IProfile {
    prop Authorization Authorization { get; set; }
    prop Token Token { get; set; }

    private prop (IProfile) Authorization Authorization -> Authorization
    private prop (IProfile) Token Token -> Token
}`

        private func FindType(reader MetadataReader, name string) TypeDefinition {
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if reader.GetString(td.Name) == name {
                    return td
                }
            }
            throw InvalidOperationException("expected to find the $name type")
        }

        private func CountMethodsNamed(reader MetadataReader, type TypeDefinition, name string) int32 {
            var count = 0
            for mh in type.GetMethods() {
                let md = reader.GetMethodDefinition(mh)
                if reader.GetString(md.Name) == name {
                    count++
                }
            }
            return count
        }

        private func CountMethodImplRows(reader MetadataReader, type TypeDefinition) int32 {
            var count = 0
            for miHandle in type.GetMethodImplementations() {
                reader.GetMethodImplementation(miHandle)
                count++
            }
            return count
        }

        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2362_lib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2362_exe_").FullName
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
