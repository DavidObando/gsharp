// <copyright file="Issue606FieldRwPropertyTests.cs" company="GSharp">
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

/// Issue #606: extend field-satisfies-property contract to read-write properties.
/// A public mutable G# field should satisfy a CLR interface property with both
/// getter and setter (previously only getter-only was supported per #573).
open class Issue606FieldRwPropertyTests {
    @Fact
    func MutableField_SatisfiesReadWritePropertyContract_BothAccessorsWork() {
        let sibling = `namespace ProbeRef606
{
    public interface IReadWrite
    {
        string Value { get; set; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef606

class Impl : IReadWrite {
    var Value string
}

var impl = Impl{Value: "hello"}
var iface IReadWrite = impl
Console.WriteLine(iface.Value)
iface.Value = "world"
Console.WriteLine(iface.Value)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606")
        Assert.Equal("hello${Environment.NewLine}world${Environment.NewLine}", output)
    }

    @Fact
    func MutableField_SatisfiesReadWritePropertyContract_SetterModifiesField() {
        let sibling = `namespace ProbeRef606
{
    public interface ICounter
    {
        int Count { get; set; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef606

class Counter : ICounter {
    var Count int32
}

var c = Counter{Count: 0}
var iface ICounter = c
iface.Count = 42
Console.WriteLine(c.Count)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606")
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func MutableField_SatisfiesReadWritePropertyContract_GetterReadsField() {
        let sibling = `namespace ProbeRef606
{
    public interface IReadWrite
    {
        string Name { get; set; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef606

class Named : IReadWrite {
    var Name string
}

var n = Named{Name: "initial"}
n.Name = "direct"
var iface IReadWrite = n
Console.WriteLine(iface.Name)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606")
        Assert.Equal("direct${Environment.NewLine}", output)
    }

    @Fact
    func Field_StillSatisfiesGetterOnlyContract() {
        // Regression: #573 behavior is preserved.
        let sibling = `namespace ProbeRef606
{
    public interface IGetOnly
    {
        string Name { get; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef606

class GetImpl : IGetOnly {
    var Name string
}

var impl = GetImpl{Name: "getter-only"}
var iface IGetOnly = impl
Console.WriteLine(iface.Name)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606")
        Assert.Equal("getter-only${Environment.NewLine}", output)
    }

    @Fact
    func PrivateField_DoesNotSatisfyReadWriteContract_ErrorsGS0187() {
        // A non-public field cannot satisfy a public interface property contract.
        let sibling = `namespace ProbeRef606
{
    public interface IReadWrite
    {
        string Value { get; set; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef606

class BadImpl : IReadWrite {
    private var Value string
}`
        let errors = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606")
        Assert.Contains(errors, (e string) -> e.Contains("GS0187"))
    }

    @Fact
    func WrongTypeField_DoesNotSatisfyReadWriteContract_ErrorsGS0187() {
        // A field with mismatched type cannot satisfy the property contract.
        let sibling = `namespace ProbeRef606
{
    public interface IReadWrite
    {
        string Value { get; set; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef606

class BadImpl : IReadWrite {
    var Value int32
}`
        let errors = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606")
        Assert.Contains(errors, (e string) -> e.Contains("GS0187"))
    }

    @Fact
    func ClassOmittingFieldEntirely_StillReportsGS0187() {
        let sibling = `namespace ProbeRef606
{
    public interface IReadWrite
    {
        string Value { get; set; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef606

class Empty : IReadWrite {
}`
        let errors = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606")
        Assert.Contains(errors, (e string) -> e.Contains("GS0187"))
    }

    shared {
        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue606_sib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue606_err_").FullName
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
