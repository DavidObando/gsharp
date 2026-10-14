// <copyright file="Issue672ClrNestedTypeAccessEmitTests.cs" company="GSharp">
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

/// Issue #672: CLR nested type access in expression position must compile,
/// IL-verify, and execute correctly. Covers nested enum value access,
/// nested class static member access, nested struct usage, and multi-level
/// nesting.
open class Issue672ClrNestedTypeAccessEmitTests {
    @Fact
    func NestedEnum_GetFolderPath_CompilesAndRuns() {
        // The issue repro: Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)
        // must compile and produce a non-null result at runtime.
        let source = `package Probe
import System

var path = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)
Console.WriteLine(path != "")`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func NestedEnum_DirectValue_CompilesAndRuns() {
        // Storing a nested enum value and printing its int representation.
        let source = `package Probe
import System

var sf = Environment.SpecialFolder.Desktop
Console.WriteLine(sf)`
        let output = CompileAndRun(source)
        // Environment.SpecialFolder.Desktop prints its enum name via ToString().
        Assert.Equal("Desktop${Environment.NewLine}", output)
    }

    @Fact
    func NestedClass_StaticMember_CompilesAndRuns() {
        // A sibling C# library defines a nested class with a static property;
        // G# accesses it via `Outer.Inner.Value`.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Outer
    {
        public sealed class Inner
        {
            public static string Value => "nested-value";
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var v = Outer.Inner.Value
Console.WriteLine(v)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("nested-value${Environment.NewLine}", output)
    }

    @Fact
    func NestedStruct_StaticField_CompilesAndRuns() {
        // A sibling C# library defines a nested struct with a static field.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Container
    {
        public struct Inner
        {
            public static int DefaultValue = 77;
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var v = Container.Inner.DefaultValue
Console.WriteLine(v)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("77${Environment.NewLine}", output)
    }

    @Fact
    func MultiLevelNesting_StaticMember_CompilesAndRuns() {
        // Three-level nesting: `Outer.Middle.Inner.Value`.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Outer
    {
        public sealed class Middle
        {
            public sealed class Inner
            {
                public static string Value => "deep";
            }
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var v = Outer.Middle.Inner.Value
Console.WriteLine(v)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("deep${Environment.NewLine}", output)
    }

    @Fact
    func NestedEnum_InSiblingLibrary_CompilesAndRuns() {
        // A nested enum in a sibling library must be accessible.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Config
    {
        public enum Mode
        {
            Fast = 1,
            Slow = 2,
            Auto = 3,
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var m = Config.Mode.Auto
Console.WriteLine(m)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("Auto${Environment.NewLine}", output)
    }

    @Fact
    func NestedType_ConstructorCall_StillWorks_Regression() {
        // Issue #569 regression guard: constructing a nested type must still work.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Factory
    {
        public sealed class Widget
        {
            public override string ToString() => "widget-ok";
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var w = Factory.Widget()
Console.WriteLine(w.ToString())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("widget-ok${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue672_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
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

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue672_sib_").FullName
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
