// <copyright file="Issue573FieldSatisfiesGetterPropertyContractTests.cs" company="GSharp">
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
import Xunit

/// Issue #573: a G# class with a public field whose name and type match a
/// getter-only CLR interface property should satisfy the interface contract.
/// Previously rejected with GS0187. The fix synthesizes a PropertySymbol
/// backed by the field at binding time.
open class Issue573FieldSatisfiesGetterPropertyContractTests {
    @Fact
    func FieldSatisfiesGetterOnlyProperty_BindsAndRuns() {
        let sibling = `namespace ProbeRef
{
    public interface IHasName
    {
        string Name { get; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef

class Impl1 : IHasName {
    var Name string
}

var impl = Impl1{Name: "hello"}
var iface IHasName = impl
Console.WriteLine(iface.Name)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func FieldMutation_VisibleThroughInterfaceProperty() {
        let sibling = `namespace ProbeRef
{
    public interface IHasName
    {
        string Name { get; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef

class Impl1 : IHasName {
    var Name string
}

var impl = Impl1{Name: "hello"}
impl.Name = "world"
var iface IHasName = impl
Console.WriteLine(iface.Name)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("world${Environment.NewLine}", output)
    }

    @Fact
    func ExplicitPropertyAccessor_StillWorks() {
        let sibling = `namespace ProbeRef
{
    public interface IHasName
    {
        string Name { get; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef

class Impl2 : IHasName {
    prop Name string { get { return "accessor" } }
}

var impl = Impl2{}
var iface IHasName = impl
Console.WriteLine(iface.Name)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("accessor${Environment.NewLine}", output)
    }

    @Fact
    func FieldSatisfiesReadWriteProperty_BindsAndRuns() {
        // #606: a field now satisfies a { get; set; } interface property.
        let sibling = `namespace ProbeRef
{
    public interface IReadWrite
    {
        string Value { get; set; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef

class RWImpl : IReadWrite {
    var Value string
}

var impl = RWImpl{Value: "initial"}
var iface IReadWrite = impl
Console.WriteLine(iface.Value)
iface.Value = "updated"
Console.WriteLine(iface.Value)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("initial${Environment.NewLine}updated${Environment.NewLine}", output)
    }

    @Fact
    func ClassOmittingPropertyEntirely_StillReportsGS0187() {
        let sibling = `namespace ProbeRef
{
    public interface IHasName
    {
        string Name { get; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef

class NoImpl : IHasName {
}`
        let errors = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Contains(errors, (e string) -> e.Contains("GS0187"))
    }

    shared {
        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue573_sib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue573_err_").FullName
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
