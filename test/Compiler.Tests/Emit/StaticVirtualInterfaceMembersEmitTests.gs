// <copyright file="StaticVirtualInterfaceMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// ADR-0089 / issue #755 — static-virtual interface members (SVIM).
/// Validates the full CLR emit shape end-to-end: the interface TypeDef
/// carries a method with `Static | Virtual | Abstract`, the
/// implementer's static method is paired to the slot via a
/// `MethodImpl` row (required by ECMA-335 §II.10.3.3 with the .NET 7
/// extension because static methods cannot be paired by name+signature
/// alone), and a generic consumer dispatches through
/// `constrained. !!T call`. Runtime execution, IL verification,
/// and cross-language interop with C# 11 are all covered.
open class StaticVirtualInterfaceMembersEmitTests {
    @Fact
    func StaticVirtualAbstract_InterfaceMetadata_HasStaticVirtualAbstractFlags() {
        let source = `package Probe
import System

sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var addHandle MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "IAdd") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "Add") {
                        addHandle = mh
                        break
                    }
                }
            }
            Assert.True((addHandle != nil), "expected to find Add on IAdd")
            let add = reader.GetMethodDefinition(addHandle!!)
            let attrs = add.Attributes
            Assert.True((attrs & MethodAttributes.Static) != 0, "static-virtual must be static")
            Assert.True((attrs & MethodAttributes.Virtual) != 0, "static-virtual must be virtual")
            Assert.True((attrs & MethodAttributes.Abstract) != 0, "abstract form must carry Abstract flag")
            Assert.Equal(0, add.RelativeVirtualAddress)
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func StaticVirtualDefault_InterfaceMetadata_VirtualNotAbstract() {
        let source = `package Probe
import System

sealed interface IZero {
    shared {
        func Zero() int32 { return 0 }
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var handle MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "IZero") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "Zero") {
                        handle = mh
                        break
                    }
                }
            }
            Assert.True((handle != nil))
            let m = reader.GetMethodDefinition(handle!!)
            Assert.True((m.Attributes & MethodAttributes.Static) != 0)
            Assert.True((m.Attributes & MethodAttributes.Virtual) != 0)
            Assert.True((m.Attributes & MethodAttributes.Abstract) == 0, "default form must NOT be Abstract")
            Assert.True(m.RelativeVirtualAddress != 0, "default body must have a real RVA")
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func Implementer_Emits_MethodImpl_PairingSlotAndImpl() {
        let source = `package Probe
import System

sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

class Adder : IAdd {
    shared {
        func Add(a int32, b int32) int32 { return a + b }
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var adder TypeDefinition? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if reader.StringComparer.Equals(td.Name, "Adder") {
                    adder = td
                    break
                }
            }
            Assert.True((adder != nil), "expected to find Adder TypeDef")
            let implsCollection = adder!!.GetMethodImplementations()
            let impls = List[MethodImplementationHandle]()
            for h in implsCollection {
                impls.Add(h)
            }
            Assert.NotEmpty(impls)
            // Verify at least one MethodImpl row points the body to a static
            // method on Adder and the declaration to IAdd::Add.
            var found = false
            for implHandle in impls {
                let mi = reader.GetMethodImplementation(implHandle)
                if mi
                    .MethodBody
                    .Kind != HandleKind.MethodDefinition ||
                    mi
                    .MethodDeclaration
                    .Kind != HandleKind.MethodDefinition {
                    continue
                }
                let body = reader.GetMethodDefinition(MethodDefinitionHandle(mi.MethodBody))
                let decl = reader.GetMethodDefinition(MethodDefinitionHandle(mi.MethodDeclaration))
                if reader.StringComparer.Equals(body.Name, "Add") && reader.StringComparer.Equals(decl.Name, "Add") {
                    Assert.True((body.Attributes & MethodAttributes.Static) != 0, "impl body must be static")
                    Assert.True((decl.Attributes & MethodAttributes.Abstract) != 0, "decl slot must be abstract")
                    found = true
                    break
                }
            }
            Assert.True(found, "expected MethodImpl pairing Adder.Add -> IAdd.Add")
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func EndToEnd_GenericDispatch_RunsAndReturnsExpected() {
        // Full ADR-0089 happy path: interface declares an abstract static
        // method; a class implements via shared-block; a generic consumer
        // dispatches through `constrained. !!T  call`. Compile, run, and
        // confirm the runtime returns the implementer's body output.
        let source = `package Probe
import System

sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

class Adder : IAdd {
    shared {
        func Add(a int32, b int32) int32 { return a + b }
    }
}

func Compute[T IAdd](w T, a int32, b int32) int32 {
    return T.Add(a, b)
}

func Main() {
    Console.WriteLine(Compute(Adder{}, 3, 4))
}`
        let output = CompileAndRun(source, ignoredErrorScope: "<Program>\\.Compute$$")
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DefaultBody_Inherited_WhenImplementerOmits() {
        // ADR-0089 §3.2: implementer that does NOT supply the static
        // override picks up the interface's default body at runtime. The
        // dispatch routes through a generic method so the witness-T
        // pattern handles type-arg inference (ADR-0087 R5/R6/R7).
        let source = `package Probe
import System

sealed interface IGreet {
    shared {
        func Hello() string { return "default-hello" }
    }
}

class Quiet : IGreet {
}

func Use[T IGreet](w T) string {
    return T.Hello()
}

func Main() {
    Console.WriteLine(Use(Quiet{}))
}`
        let output = CompileAndRun(source, ignoredErrorScope: "<Program>\\.Use$$")
        Assert.Equal("default-hello${Environment.NewLine}", output)
    }

    @Fact
    func CrossLanguage_CsharpConsumer_CallsGSharpStaticVirtual() {
        // A C# 11 consumer must be able to use a G#-declared static-virtual
        // interface: declare a struct/class that implements the interface
        // via the standard C# `static` member shape, and dispatch through
        // the interface's static-virtual slot in a generic method.
        let gsource = `package Probe
import System

public sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

public class Adder : IAdd {
    shared {
        func Add(a int32, b int32) int32 { return a + b }
    }
}`
        let consumerCs = `using System;
using Probe;

class Program
{
    static int Sum<T>(T w, int a, int b) where T : IAdd
    {
        _ = w;
        return T.Add(a, b);
    }

    static int Main()
    {
        Console.WriteLine(Sum(new Adder(), 10, 32));
        return 0;
    }
}`
        let output = CompileGsharpLibAndRunCsharpConsumer(gsource, consumerCs)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_svim_lib_").FullName
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

        private func CompileAndRun(source string, ignoredErrorScope string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_svim_exe_").FullName
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
                IlVerifier.Verify(
                    dllPath,
                    ignoredErrorCodes: if ignoredErrorScope == nil {
                        default([]?string)
                    } else {
                        IlVerifier.KnownIssues.StaticVirtualInterface
                    },
                    ignoredErrorScope: ignoredErrorScope
                )
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

        private func CompileGsharpLibAndRunCsharpConsumer(gsource string, csource string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_svim_xlang_").FullName
            try {
                // Step 1: emit the G# library.
                let gSrcPath = Path.Combine(tempDir, "lib.gs")
                let gDllPath = Path.Combine(tempDir, "Probe.dll")
                File.WriteAllText(gSrcPath, gsource)
                let gscArgs = List[string]{"/out:" + gDllPath, "/target:library", "/targetframework:net10.0", gSrcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(gscArgs.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(gDllPath)
                // Step 2: scaffold a C# console consumer.
                let csDir = Path.Combine(tempDir, "consumer")
                Directory.CreateDirectory(csDir)
                File.WriteAllText(Path.Combine(csDir, "Program.cs"), csource)
                File.WriteAllText(Path.Combine(csDir, "Consumer.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>Consumer</AssemblyName>
    <RootNamespace>Consumer</RootNamespace>
    <LangVersion>preview</LangVersion>
    <RunAnalyzers>false</RunAnalyzers>
    <EnableNETAnalyzers>false</EnableNETAnalyzers>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="Probe">
      <HintPath>` + "$gDllPath" + `</HintPath>
    </Reference>
  </ItemGroup>
</Project>`))
                RunDotnet(csDir, "restore")
                let _ = RunDotnet(
                    csDir,
                    "build",
                    "-c",
                    "Release",
                    "--nologo",
                    "--no-restore",
                    "/p:RunAnalyzers=false",
                    "/p:TreatWarningsAsErrors=false"
                )
                let consumerDll = Path.Combine(csDir, "bin", "Release", "net10.0", "Consumer.dll")
                Assert.True(File.Exists(consumerDll), "consumer not found at $consumerDll")
                File.Copy(
                    gDllPath,
                    Path.Combine(Path.GetDirectoryName(consumerDll)!!, Path.GetFileName(gDllPath)),
                    overwrite: true
                )
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = Path.GetDirectoryName(consumerDll)!!
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(consumerDll, ".runtimeconfig.json"))
                psi.ArgumentList.Add(consumerDll)
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

        private func RunDotnet(workingDir string, args ...string) string {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDir
            }
            for a in args {
                psi.ArgumentList.Add(a)
            }
            using let proc = Process.Start(psi) ??
                throw InvalidOperationException("failed to start dotnet ${string.Join(" ", args)}")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(180_000), "dotnet ${args[0]} timed out")
            Assert.True(
                proc.ExitCode == 0,
                (`dotnet ` + "${string.Join(" ", args)}" + ` failed (exit ` + "${proc.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
            return stdout
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
