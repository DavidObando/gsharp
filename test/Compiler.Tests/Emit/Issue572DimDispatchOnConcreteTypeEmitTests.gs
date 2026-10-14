// <copyright file="Issue572DimDispatchOnConcreteTypeEmitTests.cs" company="GSharp">
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

/// Issue #572: calling a default interface method (DIM) on a concrete CLR
/// class that does not override the DIM was rejected with GS0159 because
/// `ClrTypeUtilities.SafeGetMethodsIncludingInterfaces` only walked
/// interfaces when the receiver was itself an interface type. The fix
/// removes the `!type.IsInterface` guard so interface methods (DIMs)
/// are surfaced on concrete class receivers as well.
open class Issue572DimDispatchOnConcreteTypeEmitTests {
    // ---------------------------------------------------------------
    // Core DIM resolution on concrete type
    // ---------------------------------------------------------------
    @Fact
    func DimDispatch_ConcreteType_NoArgMethod() {
        let sibling = `namespace ProbeRef
{
    public interface IWithDIM
    {
        string Name { get; }
        string Greeting() => "Hello, " + Name + "!";
    }

    public class WithDIMImpl : IWithDIM
    {
        public string Name { get; }
        public WithDIMImpl(string name) { Name = name; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef

var obj = WithDIMImpl("world")
Console.WriteLine(obj.Greeting())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("Hello, world!${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Regression: through-interface still works
    // ---------------------------------------------------------------
    @Fact
    func DimDispatch_ThroughInterface_StillWorks() {
        let sibling = `namespace ProbeRef
{
    public interface IWithDIM
    {
        string Name { get; }
        string Greeting() => "Hello, " + Name + "!";
    }

    public class WithDIMImpl : IWithDIM
    {
        public string Name { get; }
        public WithDIMImpl(string name) { Name = name; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef

var obj = WithDIMImpl("world")
var iface IWithDIM = obj
Console.WriteLine(iface.Greeting())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("Hello, world!${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // DIM with parameters
    // ---------------------------------------------------------------
    @Fact
    func DimDispatch_WithParameters() {
        let sibling = `namespace ProbeRef
{
    public interface IGreeter
    {
        string Greet(string name, int times) => name + "x" + times.ToString();
    }

    public class SimpleGreeter : IGreeter { }
}`
        let gsource = `package Probe
import System
import ProbeRef

var g = SimpleGreeter()
Console.WriteLine(g.Greet("hi", 3))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("hix3${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // DIM with overloads: M() and M(int)
    // ---------------------------------------------------------------
    @Fact
    func DimDispatch_Overloaded() {
        let sibling = `namespace ProbeRef
{
    public interface IOverloaded
    {
        string M() => "noarg";
        string M(int n) => "arg:" + n.ToString();
    }

    public class OverloadedImpl : IOverloaded { }
}`
        let gsource = `package Probe
import System
import ProbeRef

var o = OverloadedImpl()
Console.WriteLine(o.M())
Console.WriteLine(o.M(42))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("noarg${Environment.NewLine}arg:42${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Class explicitly overrides DIM — class version wins
    // ---------------------------------------------------------------
    @Fact
    func DimDispatch_OverriddenDim_PrefersConcrete() {
        let sibling = `namespace ProbeRef
{
    public interface IWithDIM
    {
        string Name { get; }
        string Greeting() => "Hello, " + Name + "!";
    }

    public class WithOverride : IWithDIM
    {
        public string Name { get; }
        public WithOverride(string name) { Name = name; }
        public string Greeting() => "Overridden: " + Name;
    }
}`
        let gsource = `package Probe
import System
import ProbeRef

var obj = WithOverride("world")
Console.WriteLine(obj.Greeting())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("Overridden: world${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // DIM inherited from grandparent interface (I3 : I2, I2 : I1, DIM on I1)
    // ---------------------------------------------------------------
    @Fact
    func DimDispatch_TransitiveInheritance() {
        let sibling = `namespace ProbeRef
{
    public interface IGrandparent
    {
        string Deep() => "deep-dim";
    }

    public interface IParent : IGrandparent { }
    public interface IChild : IParent { }

    public class DeepImpl : IChild { }
}`
        let gsource = `package Probe
import System
import ProbeRef

var d = DeepImpl()
Console.WriteLine(d.Deep())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("deep-dim${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // DIM on a sealed class
    // ---------------------------------------------------------------
    @Fact
    func DimDispatch_SealedClass() {
        let sibling = `namespace ProbeRef
{
    public interface ISealable
    {
        string Tag() => "sealed-dim";
    }

    public sealed class SealedImpl : ISealable { }
}`
        let gsource = `package Probe
import System
import ProbeRef

var s = SealedImpl()
Console.WriteLine(s.Tag())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("sealed-dim${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // DIM property (default interface property with body)
    // ---------------------------------------------------------------
    @Fact
    func DimDispatch_Property() {
        let sibling = `namespace ProbeRef
{
    public interface IHasDefaultProp
    {
        string Label => "default-label";
    }

    public class PropImpl : IHasDefaultProp { }
}`
        let gsource = `package Probe
import System
import ProbeRef

var p = PropImpl()
Console.WriteLine(p.Label)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("default-label${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Multiple interfaces each with a DIM — both resolvable
    // ---------------------------------------------------------------
    @Fact
    func DimDispatch_MultipleInterfaces() {
        let sibling = `namespace ProbeRef
{
    public interface IFoo
    {
        string Foo() => "foo-dim";
    }

    public interface IBar
    {
        string Bar() => "bar-dim";
    }

    public class MultImpl : IFoo, IBar { }
}`
        let gsource = `package Probe
import System
import ProbeRef

var m = MultImpl()
Console.WriteLine(m.Foo())
Console.WriteLine(m.Bar())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("foo-dim${Environment.NewLine}bar-dim${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Generic interface with DIM
    // ---------------------------------------------------------------
    @Fact
    func DimDispatch_GenericInterface() {
        let sibling = `namespace ProbeRef
{
    public interface IGen<T>
    {
        string Describe() => typeof(T).Name;
    }

    public class GenImpl : IGen<int> { }
}`
        let gsource = `package Probe
import System
import ProbeRef

var g = GenImpl()
Console.WriteLine(g.Describe())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("Int32${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue572_sib_").FullName
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
