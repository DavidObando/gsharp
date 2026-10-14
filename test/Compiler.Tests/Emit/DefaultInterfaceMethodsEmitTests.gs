// <copyright file="DefaultInterfaceMethodsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// ADR-0085 / issue #726: default-interface methods (DIM). Validates the
/// CLR emit shape — interface TypeDef carries a virtual non-abstract method
/// with a body, and an implementer that omits the method inherits the
/// default at runtime through normal virtual dispatch. A cross-language
/// test compiles G# as a library and consumes it from a C# program that
/// calls the default through an interface reference.
open class DefaultInterfaceMethodsEmitTests {
    @Fact
    func DefaultInterfaceMethod_InterfaceMetadata_IsVirtualNotAbstract() {
        let source = `package Probe
import System

interface IGreeter {
    func Hello() string { return "hi" }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var helloHandle MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "IGreeter") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "Hello") {
                        helloHandle = mh
                        break
                    }
                }
            }
            Assert.True((helloHandle != nil), "expected to find Hello on IGreeter")
            let hello = reader.GetMethodDefinition(helloHandle!!)
            // Default interface methods must be virtual but NOT abstract,
            // and must carry a body (RVA != 0).
            Assert.True((hello.Attributes & MethodAttributes.Virtual) != 0, "DIM must be virtual")
            Assert.True((hello.Attributes & MethodAttributes.Abstract) == 0, "DIM must not be abstract")
            Assert.True(hello.RelativeVirtualAddress != 0, "DIM must carry a body (non-zero RVA)")
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func DefaultInterfaceMethod_InheritedAtRuntime_ViaInterfaceReceiver() {
        // Cross-language: emit G# library with an interface that exposes a
        // default and a class that inherits it. A small C# consumer then
        // calls the default through an interface-typed reference. The
        // observable behavior must match the G#-side dispatch.
        let gsource = `package Probe
import System

public interface IGreeter {
    func Hello() string { return "hi (default)" }
}

public class Quiet : IGreeter {
}

public class Loud : IGreeter {
    func Hello() string { return "LOUD" }
}`
        let consumerCs = `using System;
using Probe;

class Program
{
    static int Main()
    {
        IGreeter q = new Quiet();
        IGreeter l = new Loud();
        Console.WriteLine(q.Hello());
        Console.WriteLine(l.Hello());
        return 0;
    }
}`
        let output = CompileGsharpLibAndRunCsharpConsumer(gsource, consumerCs)
        Assert.Equal("hi (default)${Environment.NewLine}LOUD${Environment.NewLine}", output)
    }

    @Fact
    func ImplicitObjectMembers_InDefaultMethod_CompileInInterpolatedAndOrdinaryExpressions() {
        let source = `package Probe
import System

interface IProbe {
    func Describe() string { return "${GetType().Name}" }
    func RuntimeType() Type { return GetType() }
    func Hash() int32 { return GetHashCode() }
    func Same() bool { return Equals(this) }
    func Text() string? { return ToString() }
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func ImplicitObjectMembers_InDefaultMethod_Run() {
        let gsource = `package Probe

public interface IProbe {
    func Describe() string { return "${GetType().Name}" }
    func HashStable() bool { return GetHashCode() == GetHashCode() }
    func Same() bool { return Equals(this) }
}

public class ProbeImpl : IProbe {
}`
        let consumerCs = `using System;
using Probe;

IProbe probe = new ProbeImpl();
Console.WriteLine(probe.Describe());
Console.WriteLine(probe.HashStable());
Console.WriteLine(probe.Same());`
        Assert.Equal(
            "ProbeImpl${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileGsharpLibAndRunCsharpConsumer(gsource, consumerCs)
        )
    }

    @Fact
    func ImplicitObjectLookup_UnknownMethod_StillReportsGS0130() {
        let source = `package Probe

interface IProbe {
    func Broken() string { return MissingObjectMember() }
}`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0130") && d.Contains("MissingObjectMember"))
    }

    @Fact
    func DefaultInterfaceMethod_ConflictingDefaults_ReportsGS0318() {
        // Diamond-conflict diagnostic surfaces from gsc when two unrelated
        // interfaces both provide a default for the same signature and the
        // implementing class fails to disambiguate.
        let source = `package Probe

interface IA {
    func F() int32 { return 1 }
}

interface IB {
    func F() int32 { return 2 }
}

class C : IA, IB {
}`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0318"))
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_dim_lib_").FullName
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

        private func CompileExpectingErrors(source string)[]string {
            let tempDir = Directory.CreateTempSubdirectory("gs_dim_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                File.WriteAllText(srcPath, source)
                let args = []string{
                    "/out:" + Path.Combine(tempDir, "test.dll"),
                    "/target:library",
                    "/targetframework:net10.0",
                    srcPath
                }
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                try {
                    let _ = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                return stdoutWriter.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileGsharpLibAndRunCsharpConsumer(gsource string, csource string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_dim_xlang_").FullName
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
                // Step 2: scaffold a C# console consumer that references the
                // G# library through a /reference and runs through `dotnet`.
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
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="Probe">
      <HintPath>` + "$gDllPath" + `</HintPath>
    </Reference>
  </ItemGroup>
</Project>`))
                RunDotnet(csDir, "restore")
                let _ = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
                let consumerDll = Path.Combine(csDir, "bin", "Release", "net10.0", "Consumer.dll")
                Assert.True(File.Exists(consumerDll), "consumer not found at $consumerDll")
                // Step 3: copy the G# library next to the consumer so the
                // runtime probing path resolves it, then exec.
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
