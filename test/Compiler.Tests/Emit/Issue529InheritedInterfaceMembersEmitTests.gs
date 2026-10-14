// <copyright file="Issue529InheritedInterfaceMembersEmitTests.cs" company="GSharp">
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

/// Issue #529: member lookup on a CLR interface type must walk the
/// inherited interface chain. `IReadOnlyList<T>.Count` is
/// declared on `IReadOnlyCollection<T>` but must be
/// accessible through an `IReadOnlyList<T>`-typed receiver.
/// The same applies to methods (e.g. `GetEnumerator()` inherited
/// via `IEnumerable<T>`).
open class Issue529InheritedInterfaceMembersEmitTests {
    // ---------------------------------------------------------------
    // BCL interface hierarchy: IReadOnlyList<T>
    // ---------------------------------------------------------------
    @Fact
    func IReadOnlyList_Count_InheritedFromIReadOnlyCollection() {
        let source = `package Probe
import System
import System.Collections.Generic

var xs = List[string]()
xs.Add("a")
xs.Add("b")
let items IReadOnlyList[string] = xs
Console.WriteLine(items.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func IReadOnlyList_GetEnumerator_InheritedViaIEnumerable() {
        // GetEnumerator() is declared on IEnumerable<T> which
        // IReadOnlyList<T> inherits. The non-generic IEnumerable
        // version is hidden by C# interface hiding rules.
        let source = `package Probe
import System
import System.Collections.Generic

var xs = List[string]()
xs.Add("hello")
let items IReadOnlyList[string] = xs
let e = items.GetEnumerator()
e.MoveNext()
Console.WriteLine(e.Current)`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Sibling C# probe: custom interface hierarchy (method)
    // ---------------------------------------------------------------
    @Fact
    func SiblingCSharp_MethodInherited_IA_CalledThroughIB() {
        let sibling = `namespace Probe.CSharp
{
    public interface IA
    {
        string M();
    }

    public interface IB : IA
    {
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class Impl : IA, IB {
    func M() string { return "from IA via IB" }
}

let x IB = Impl{}
Console.WriteLine(x.M())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("from IA via IB${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Sibling C# probe: custom interface hierarchy (property)
    // ---------------------------------------------------------------
    @Fact
    func SiblingCSharp_PropertyInherited_IA_ReadThroughIB() {
        let sibling = `namespace Probe.CSharp
{
    public interface IA
    {
        string Name { get; }
    }

    public interface IB : IA
    {
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class Named : IA, IB {
    prop Name string { get { return "hello" } }
}

let x IB = Named{}
Console.WriteLine(x.Name)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Three-level interface hierarchy
    // ---------------------------------------------------------------
    @Fact
    func SiblingCSharp_ThreeLevelHierarchy_MethodOnBaseReachable() {
        let sibling = `namespace Probe.CSharp
{
    public interface IBase
    {
        string Root();
    }

    public interface IMid : IBase
    {
    }

    public interface ILeaf : IMid
    {
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class Deep : IBase, IMid, ILeaf {
    func Root() string { return "deep" }
}

let x ILeaf = Deep{}
Console.WriteLine(x.Root())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("deep${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Regression: members directly declared on the interface bind
    // ---------------------------------------------------------------
    @Fact
    func Regression_DirectMembersOnInterface_StillBind() {
        let sibling = `namespace Probe.CSharp
{
    public interface IDirect
    {
        string DirectMethod();
        string DirectProp { get; }
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class DirectImpl : IDirect {
    func DirectMethod() string { return "dm" }
    prop DirectProp string { get { return "dp" } }
}

let x IDirect = DirectImpl{}
Console.WriteLine(x.DirectMethod())
Console.WriteLine(x.DirectProp)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("dm${Environment.NewLine}dp${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Regression: concrete class member lookup unchanged
    // ---------------------------------------------------------------
    @Fact
    func Regression_ConcreteClassMemberLookup_Unchanged() {
        let source = `package Probe
import System
import System.Collections.Generic

var items = List[string]()
items.Add("a")
items.Add("b")
items.Add("c")
Console.WriteLine(items.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Sibling C# probe: IB extends IA, IB also declares own members
    // ---------------------------------------------------------------
    @Fact
    func SiblingCSharp_IBHasOwnAndInheritedMembers() {
        let sibling = `namespace Probe.CSharp
{
    public interface IA
    {
        string FromA();
    }

    public interface IB : IA
    {
        string FromB();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class Both : IA, IB {
    func FromA() string { return "a" }
    func FromB() string { return "b" }
}

let x IB = Both{}
Console.WriteLine(x.FromA())
Console.WriteLine(x.FromB())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}", output)
    }

    shared {
        // ---------------------------------------------------------------
        // Helpers (mirror Issue525 pattern)
        // ---------------------------------------------------------------
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue529_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue529_sib_").FullName
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
