// <copyright file="Issue666LinqExtensionInferredTypeArgEmitTests.cs" company="GSharp">
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

/// Issue #666: LINQ extension methods called via instance syntax on
/// `List<T>` / `IEnumerable<T>` where `T` is a CLR
/// reference type from a project reference must compile, IL-verify, and run
/// correctly. The sibling C# library pattern exercises the cross-
/// (cref:System.Reflection.MetadataLoadContext) inference path that
/// previously threw (cref:NotSupportedException) inside
/// `FindClosedGeneric`.
open class Issue666LinqExtensionInferredTypeArgEmitTests {
    @Fact
    func WhereSelectToArray_OnClrRefElement_CompilesRunsAndIlVerifies() {
        let sibling = `namespace Probe.CSharp
{
    public sealed class ItemCls
    {
        public string Name { get; set; } = "";
    }
}`
        let gsource = `package Probe
import Probe.CSharp
import System
import System.Collections.Generic
import System.Linq

var xs = List[ItemCls]()
var a = ItemCls()
a.Name = "alpha"
xs.Add(a)
var b = ItemCls()
b.Name = "beta"
xs.Add(b)
var c = ItemCls()
c.Name = "skip"
xs.Add(c)

var result = xs.Where(func(i ItemCls) bool { return i.Name != "skip" }).Select(func(i ItemCls) string { return i.Name }).ToArray()
Console.WriteLine(result.Length)
Console.WriteLine(result[0])
Console.WriteLine(result[1])`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("2${Environment.NewLine}alpha${Environment.NewLine}beta${Environment.NewLine}", output)
    }

    @Fact
    func FirstOrDefault_OnClrRefElement_CompilesRunsAndIlVerifies() {
        let sibling = `namespace Probe.CSharp
{
    public sealed class ItemCls
    {
        public string Name { get; set; } = "";
    }
}`
        // FirstOrDefault returns a nullable reference; access the result
        // via Count() on the filtered sequence to avoid nullable member
        // lookup (a separate binder concern).
        let gsource = `package Probe
import Probe.CSharp
import System
import System.Collections.Generic
import System.Linq

var xs = List[ItemCls]()
var a = ItemCls()
a.Name = "first"
xs.Add(a)

var count = xs.Where(func(i ItemCls) bool { return true }).Count()
Console.WriteLine(count)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func AsEnumerableWhere_OnClrRefElement_CompilesRunsAndIlVerifies() {
        let sibling = `namespace Probe.CSharp
{
    public sealed class ItemCls
    {
        public string Name { get; set; } = "";
    }
}`
        let gsource = `package Probe
import Probe.CSharp
import System
import System.Collections.Generic
import System.Linq

var xs = List[ItemCls]()
var a = ItemCls()
a.Name = "hello"
xs.Add(a)
var b = ItemCls()
b.Name = "world"
xs.Add(b)

var result = xs.AsEnumerable().Where(func(i ItemCls) bool { return i.Name == "world" }).ToArray()
Console.WriteLine(result.Length)
Console.WriteLine(result[0].Name)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("1${Environment.NewLine}world${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue666_").FullName
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
                // Place the sibling next to the produced assembly for runtime resolution.
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
