// <copyright file="Issue569NestedTypeConstructionTests.cs" company="GSharp">
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

/// Issue #569: nested CLR types must be constructible via `Outer.Inner()`
/// in call/construction-expression position. The binder must unify the
/// call-expression resolution path with the type-clause path that #526 fixed,
/// so that `Outer.Inner(args)` binds as a constructor invocation when
/// `Inner` is a nested type of `Outer`.
open class Issue569NestedTypeConstructionTests {
    @Fact
    func NestedType_InInstanceOuter_Constructs_CompilesAndRuns() {
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

let f = InstanceOuter.NestedFactory()
Console.WriteLine(f.Value)
let g = InstanceOuter.NestedFactory(7)
Console.WriteLine(g.Value)`
        let output = CompileAndRunWithSiblingCs(InstanceOuterSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("42${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func NestedType_InStaticOuter_Constructs_CompilesAndRuns() {
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

let f = StaticOuter.NestedFactory()
Console.WriteLine(f.Value)
let g = StaticOuter.NestedFactory(5)
Console.WriteLine(g.Value)`
        let output = CompileAndRunWithSiblingCs(StaticOuterSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("99${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func NestedType_Deeply_OuterMiddleInner_Constructs_CompilesAndRuns() {
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

let a = Outer.Middle.Inner()
Console.WriteLine(a.N)
let b = Outer.Middle.Inner(123)
Console.WriteLine(b.N)`
        let output = CompileAndRunWithSiblingCs(DeeplyNestedSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("7${Environment.NewLine}123${Environment.NewLine}", output)
    }

    @Fact
    func NestedType_WithObjectInitializer_ConstructsAndSetsFields() {
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

let f = InstanceOuter.NestedFactory() { Value = 55 }
Console.WriteLine(f.Value)`
        let output = CompileAndRunWithSiblingCs(InstanceOuterSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("55${Environment.NewLine}", output)
    }

    @Fact
    func NestedType_PassedAsArgumentToCtor_CompilesAndRuns() {
        // Construct a nested type and pass it directly as an argument
        // to another function — exercises the bound expression flowing
        // through the call-argument position.
        let sibling = `namespace Probe.CSharp
{
    public class Container
    {
        public class Payload
        {
            public int X { get; }
            public Payload(int x) { X = x; }
        }

        public static int Extract(Payload p) => p.X;
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

let result = Container.Extract(Container.Payload(42))
Console.WriteLine(result)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func NestedType_NonExistentInner_StillErrors_GS0159() {
        // A typo'd nested type name must still error (not silently pass).
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

let f = InstanceOuter.Bogus()`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(
            InstanceOuterSiblingCs,
            gsource,
            siblingName: "Probe.CSharp"
        )
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0159") || d.Contains("Cannot find function"))
    }

    @Fact
    func NestedType_AsTypeClause_StillWorks() {
        // Pin the #526 fix: nested type in type-clause position must
        // still resolve correctly.
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var f InstanceOuter.NestedFactory = InstanceOuter.NestedFactory(10)
Console.WriteLine(f.Value)`
        let output = CompileAndRunWithSiblingCs(InstanceOuterSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("10${Environment.NewLine}", output)
    }

    @Fact
    func NestedType_AsBaseType_StillWorks() {
        // Pin the #526 fix: nested interface as base type must still work.
        let sibling = `namespace Probe.CSharp
{
    public class Outer
    {
        public interface INested
        {
            int Compute();
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

class Impl : Outer.INested {
    func Compute() int32 { return 77 }
}

var i Outer.INested = Impl{}
Console.WriteLine(i.Compute())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("77${Environment.NewLine}", output)
    }

    shared {
        private const InstanceOuterSiblingCs string = `namespace Probe.CSharp
{
    public class InstanceOuter
    {
        public class NestedFactory
        {
            public int Value { get; set; }
            public NestedFactory() { Value = 42; }
            public NestedFactory(int v) { Value = v; }
            public override string ToString() => $"NestedFactory({Value})";
        }
    }
}`

        private const StaticOuterSiblingCs string = `namespace Probe.CSharp
{
    public static class StaticOuter
    {
        public class NestedFactory
        {
            public int Value { get; set; }
            public NestedFactory() { Value = 99; }
            public NestedFactory(int v) { Value = v; }
            public override string ToString() => $"NestedFactory({Value})";
        }
    }
}`

        private const DeeplyNestedSiblingCs string = `namespace Probe.CSharp
{
    public class Outer
    {
        public class Middle
        {
            public class Inner
            {
                public int N { get; }
                public Inner() { N = 7; }
                public Inner(int n) { N = n; }
                public override string ToString() => $"Inner({N})";
            }
        }
    }
}`

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue569_sib_").FullName
            try {
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

        private func CompileExpectingErrorsWithSiblingCs(csSource string, gSource string, siblingName string) List[
            string
        ] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue569_err_").FullName
            try {
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
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, gSource)
                let gscArgs = List[string]{
                    "/out:" + outPath,
                    "/target:library",
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
                Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded")
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
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
            Assert.True(proc.WaitForExit(120_000), "dotnet ${args[0]} timed out")
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
