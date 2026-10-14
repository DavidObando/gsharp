// <copyright file="Issue525ClassImplementsClrInterfaceEmitTests.cs" company="GSharp">
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

/// Issue #525: a G# class declaring `class X : ISomething { ... }`
/// against a reachable CLR interface must (1) bind without GS0157, (2) emit
/// real `InterfaceImpl` metadata so the produced TypeDef is a CLR
/// implementer of the interface, and (3) dispatch through an interface
/// receiver to the G# class's implementation at runtime.
///
/// Each happy-path test compiles via `gsc`, runs `ilverify` on the
/// produced assembly, then either reflects the emitted metadata or runs the
/// assembly under `dotnet exec` to assert end-to-end behavior.
open class Issue525ClassImplementsClrInterfaceEmitTests {
    @Fact
    func GSharpClass_ImplementsBclInterface_RunsAndIlVerifies() {
        // Canonical happy-path: G# class declares it implements a CLR
        // single-method interface (IDisposable), provides the method, and
        // dispatch through an interface-typed local hits the G# body.
        let source = `package Probe
import System

class MyDisposable : IDisposable {
    func Dispose() {
        Console.WriteLine("disposed")
    }
}

var d IDisposable = MyDisposable{}
d.Dispose()`
        let output = CompileAndRun(source)
        Assert.Equal("disposed${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_ImplementsConstructedClrGenericInterface_RunsAndIlVerifies() {
        let source = `package Probe
import System

class MyStringComparable : IComparable[string] {
    func CompareTo(other string) int32 {
        return 0
    }
}

var c IComparable[string] = MyStringComparable{}
Console.WriteLine(c.CompareTo("x"))`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_MetadataDeclaresInterfaceImpl() {
        // Reflect over the emitted assembly with a MetadataLoadContext to
        // confirm the resulting TypeDef carries an InterfaceImpl row for
        // System.IDisposable (so consumers see a real CLR implementer).
        let source = `package Probe
import System

class MyDisposable : IDisposable {
    func Dispose() {
        Console.WriteLine("disposed")
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            // Use a MetadataLoadContext so we can introspect the emitted
            // type without locking the assembly or polluting the test
            // process's AppDomain.
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let resolver = PathAssemblyResolver(Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath}))
            using let mlc = MetadataLoadContext(resolver, "System.Private.CoreLib")
            let asm = mlc.LoadFromAssemblyPath(dllPath)
            let type = asm.GetType("Probe.MyDisposable") ?? throw InvalidOperationException("type not found")
            let interfaces = type.GetInterfaces().Select((i Type) -> i.FullName!!).ToArray()
            Assert.Contains("System.IDisposable", interfaces)
            // The method must be virtual+newslot so the CLR vtable wires it
            // to IDisposable.Dispose for interface dispatch.
            let method = type.GetMethod("Dispose") ?? throw InvalidOperationException("Dispose not found")
            Assert.True(method.IsVirtual, "Dispose() must be virtual to implement the interface")
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func GSharpClass_ImplementsMultipleClrInterfaces_BothReachable() {
        // The base-type clause carries TWO CLR interfaces: IDisposable and
        // ICloneable. Both must be wired as InterfaceImpl rows so dispatch
        // works through either contract.
        let source = `package Probe
import System

class Box : IDisposable, ICloneable {
    func Dispose() {
        Console.WriteLine("gone")
    }
    func Clone() object {
        return "clone"
    }
}

var b = Box{}
var c ICloneable = b
Console.WriteLine(c.Clone())
var d IDisposable = b
d.Dispose()`
        let output = CompileAndRun(source)
        Assert.Equal("clone${Environment.NewLine}gone${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_ImplementsClrInterfaceWithReadOnlyProperty_DispatchesGetter() {
        // IPropertyShape exposes a single readable property. The G# class
        // declares an auto-property of the matching name and type; the
        // emitter must promote the getter to virtual+newslot so the
        // property accessor satisfies the interface slot.
        //
        // We can't easily synthesise a custom property-only BCL interface,
        // so cover the "has a property" shape with a sibling C# library
        // and have the G# code implement it.
        let sibling = `namespace ProbeRef
{
    public interface ILabel
    {
        string Label { get; }
    }
}`
        let gsource = `package Probe
import System
import ProbeRef

class Boxed : ILabel {
    prop Label string { get { return "hello" } }
}

var b = Boxed{}
var l ILabel = b
Console.WriteLine(l.Label)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef")
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_ImplementsSiblingCSharpInterface_IssueRepro() {
        // Exact shape from the issue body: a sibling C# library exposes
        // IGreeter; the G# class implements it and is consumed through
        // the interface receiver.
        let sibling = `namespace Probe.CSharp
{
    public interface IGreeter
    {
        string Greet(string name);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MyGreeter : IGreeter {
    func Greet(name string) string { return "hi " + name }
}

var g IGreeter = MyGreeter{}
Console.WriteLine(g.Greet("world"))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("hi world${Environment.NewLine}", output)
    }

    @Fact
    func ClrInterface_FromNonImportedNamespace_StillErrors() {
        // A typo / non-existent identifier in the base clause must still
        // produce a binding error — generic base-type support must not
        // silently swallow unknown base names.
        let source = `package Probe

class Oops : INotAnInterfaceThatExistsAnywhere {
    func Foo() {}
}`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(diagnostics, (d string) -> d.Contains("INotAnInterfaceThatExistsAnywhere"))
    }

    @Fact
    func GSharpClassHierarchy_StillCompiles_RegressionGuard() {
        // Regression guard: a G#-only class hierarchy (no CLR interfaces)
        // must continue to work exactly as before — the new CLR-interface
        // resolution must not break the existing base-clause behavior.
        let source = `package Probe
import System

open class Animal {
    func Sound() string { return "generic" }
}

class Dog : Animal {
    func Bark() string { return "woof" }
}

var d = Dog{}
Console.WriteLine(d.Bark())`
        let output = CompileAndRun(source)
        Assert.Equal("woof${Environment.NewLine}", output)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue525_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue525_").FullName
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

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue525_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
                Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded")
                // gsc writes diagnostics to stdout in this repo; surface both
                // streams so a brittle test failure is easy to diagnose.
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue525_sib_").FullName
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
                // Passing /reference: switches gsc to closed-world reference mode
                // (only explicit refs are loaded), so the full BCL closure from
                // the host's TPA must be enumerated as well. Matches the pattern
                // in Issue520ClrArrayForRangeTests.
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
                // Place the sibling next to the produced assembly so the
                // probing path resolves it at runtime.
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
            // Restore + build the sibling C# library and return the produced
            // assembly path. Done in two `dotnet` invocations so failures
            // surface a clean error message.
            RunDotnet(csDir, "restore")
            let stdout = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
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
