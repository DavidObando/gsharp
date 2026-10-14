// <copyright file="Issue658CtorClrInterfaceParamEmitTests.cs" company="GSharp">
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
import Xunit

/// Issue #658: a G# class implementing a CLR interface must be passable
/// directly to a constructor or method parameter typed as that interface,
/// without requiring an explicit upcast or interface-typed local. Covers the
/// interaction with default-valued parameters (synthesized overload arity).
open class Issue658CtorClrInterfaceParamEmitTests {
    @Fact
    func CtorWithInterfaceParam_MultiArg_CompilesAndRuns() {
        // Exact repro from issue body: JobScheduler(IExecutor, int = 3).
        let sibling = `namespace Probe.CSharp
{
    public interface IExecutor { void Run(); }
    public sealed class JobScheduler
    {
        private readonly IExecutor _executor;
        private readonly int _retries;
        public JobScheduler(IExecutor executor, int retries = 3)
        {
            _executor = executor;
            _retries = retries;
        }
        public void Execute()
        {
            System.Console.WriteLine("retries=" + _retries);
            _executor.Run();
        }
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class ProbeExecutor : IExecutor {
    func Run() {
        Console.WriteLine("executed")
    }
}

let e = ProbeExecutor{}
let s = JobScheduler(e, 5)
s.Execute()`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("retries=5${Environment.NewLine}executed${Environment.NewLine}", output)
    }

    @Fact
    func CtorWithInterfaceParam_SingleArg_DefaultUsed() {
        // Single-argument call relying on default value.
        let sibling = `namespace Probe.CSharp
{
    public interface IExecutor { void Run(); }
    public sealed class JobScheduler
    {
        private readonly int _retries;
        public JobScheduler(IExecutor executor, int retries = 3)
        {
            _retries = retries;
            executor.Run();
        }
        public int Retries => _retries;
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class ProbeExecutor : IExecutor {
    func Run() {
        Console.WriteLine("ran")
    }
}

let e = ProbeExecutor{}
let s = JobScheduler(e)
Console.WriteLine(s.Retries)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("ran${Environment.NewLine}3${Environment.NewLine}", output)
    }

    @Fact
    func WorkaroundExplicitTypeAnnotation_StillWorks() {
        let sibling = `namespace Probe.CSharp
{
    public interface IExecutor { void Run(); }
    public sealed class JobScheduler
    {
        public JobScheduler(IExecutor executor, int retries = 3)
        {
            executor.Run();
        }
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class ProbeExecutor : IExecutor {
    func Run() {
        Console.WriteLine("annotated")
    }
}

let exe IExecutor = ProbeExecutor{}
let s = JobScheduler(exe, 5)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("annotated${Environment.NewLine}", output)
    }

    @Fact
    func WorkaroundAsExpression_StillWorks() {
        let sibling = `namespace Probe.CSharp
{
    public interface IExecutor { void Run(); }
    public sealed class JobScheduler
    {
        public JobScheduler(IExecutor executor, int retries = 3)
        {
            executor.Run();
        }
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class ProbeExecutor : IExecutor {
    func Run() {
        Console.WriteLine("as-cast")
    }
}

let exe = ProbeExecutor{} as IExecutor
let s = JobScheduler(exe, 5)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("as-cast${Environment.NewLine}", output)
    }

    @Fact
    func MethodCallWithInterfaceParam_CompilesAndRuns() {
        // Verify the same fix applies to regular method calls (not just ctors).
        let sibling = `namespace Probe.CSharp
{
    public interface IExecutor { void Run(); }
    public static class Runner
    {
        public static void Launch(IExecutor executor, int times = 1)
        {
            for (int i = 0; i < times; i++)
                executor.Run();
        }
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class ProbeExecutor : IExecutor {
    func Run() {
        Console.WriteLine("go")
    }
}

let e = ProbeExecutor{}
Runner.Launch(e, 2)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("go${Environment.NewLine}go${Environment.NewLine}", output)
    }

    @Fact
    func MethodCallWithInterfaceParam_SingleArg_DefaultUsed() {
        let sibling = `namespace Probe.CSharp
{
    public interface IExecutor { void Run(); }
    public static class Runner
    {
        public static void Launch(IExecutor executor, int times = 1)
        {
            for (int i = 0; i < times; i++)
                executor.Run();
        }
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class ProbeExecutor : IExecutor {
    func Run() {
        Console.WriteLine("single")
    }
}

let e = ProbeExecutor{}
Runner.Launch(e)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("single${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue658_sib_").FullName
            try {
                // Step 1: compile the sibling C# library.
                let csDir = Path.Combine(tempDir, "csref")
                Directory.CreateDirectory(csDir)
                File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource)
                File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>` + "$siblingName" + `</AssemblyName>
    <RootNamespace>` + "$siblingName" + `</RootNamespace>
  </PropertyGroup>
</Project>`))
                let siblingDll = BuildCsProject(csDir, siblingName)
                // Step 2: compile the G# code referencing the sibling.
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, gSource)
                let gscArgs = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + siblingDll
                }
                for reference in TrustedPlatformAssemblies() {
                    gscArgs.Add("/reference:" + reference)
                }
                gscArgs.Add("/nowarn:GS9100")
                gscArgs.Add(srcPath)
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
                File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true)
                IlVerifier.Verify(outPath, additionalReferences: []string{siblingDll})
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
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

        private func BuildCsProject(csDir string, siblingName string) string {
            RunDotnet(csDir, "restore")
            RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
            let dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll")
            Assert.True(File.Exists(dll), "sibling assembly not found at $dll")
            return dll
        }

        private func RunDotnet(workingDir string, args ...string) {
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
            Assert.True(proc.WaitForExit(120_000), "dotnet ${args[0]} timed out")
            Assert.True(
                proc.ExitCode == 0,
                (`dotnet ` + "${string.Join(" ", args)}" + ` failed (exit ` + "${proc.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
