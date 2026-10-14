// <copyright file="Issue526NestedClrTypeEmitTests.cs" company="GSharp">
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

/// Issue #526: nested CLR types must be reachable via a dotted-qualifier type
/// clause (`Outer.Inner`). The parser, binder, and emitter must
/// collaborate so that the dotted form (1) parses in every type-clause
/// position (variable declaration, parameter, return, base-type clause),
/// (2) resolves to the nested CLR (cref:Type) via
/// (cref:Type.GetNestedType(string, BindingFlags)), and (3) emits an
/// assembly that `ilverify`-clean and dispatches correctly at runtime.
open class Issue526NestedClrTypeEmitTests {
    @Fact
    func Var_With_NestedClrInterface_TypeClause_Compiles() {
        // The exact issue-body repro: a sibling C# probe defines `Outer.INested`
        // and the G# code declares `var x Outer.INested = nil`. Before the fix
        // this produced two GS0005 parser errors (unexpected `.`). After the
        // fix the assembly compiles, ilverifies, and runs cleanly.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Outer
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

class Maker : Outer.INested {
    func Compute() int32 { return 11 }
}

class X {
    func Use() {
        var x Outer.INested = Maker{}
        Console.WriteLine(x.Compute())
    }
}

var inst = X{}
inst.Use()`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("11${Environment.NewLine}", output)
    }

    @Fact
    func ClassImplements_NestedClrInterface_EmitsRunsAndDispatches() {
        // End-to-end: a G# class declares it implements a nested CLR
        // interface, provides the method, and dispatches through an
        // interface-typed local. Verifies (a) base-clause parsing accepts
        // `Outer.INested`, (b) the binder resolves it to the nested CLR
        // interface, (c) the emitter wires the InterfaceImpl row and a
        // virtual+newslot method, and (d) IL verifies + runs cleanly.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Outer
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
    func Compute() int32 { return 42 }
}

var i Outer.INested = Impl{}
Console.WriteLine(i.Compute())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Function_ArgumentAndReturn_With_NestedClrInterface_TypeClause() {
        // Argument-type and return-type positions must also accept the
        // dotted-qualifier form. The function returns a nested-typed value
        // it received as an argument; round-tripping through both positions
        // exercises the binder for parameter and return types.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Outer
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
    func Compute() int32 { return 7 }
}

func Echo(x Outer.INested) Outer.INested {
    return x
}

var v Outer.INested = Impl{}
Console.WriteLine(Echo(v).Compute())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func ThreeLevel_Nested_Type_Resolves() {
        // `A.B.C` — three-level nesting. The binder must walk two
        // Type.GetNestedType calls to land on the innermost interface.
        let sibling = `namespace Probe.CSharp
{
    public sealed class A
    {
        public sealed class B
        {
            public interface C
            {
                int Compute();
            }
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

class Impl : A.B.C {
    func Compute() int32 { return 99 }
}

var v A.B.C = Impl{}
Console.WriteLine(v.Compute())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func FullyQualified_Dotted_Name_Resolves_Without_Import() {
        // Even without `import Probe.CSharp`, the fully-qualified
        // `Probe.CSharp.Outer.INested` form must resolve.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Outer
    {
        public interface INested
        {
            int Compute();
        }
    }
}`
        let gsource = `package Probe.Tests
import System

class Impl : Probe.CSharp.Outer.INested {
    func Compute() int32 { return 5 }
}

var v Probe.CSharp.Outer.INested = Impl{}
Console.WriteLine(v.Compute())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func MissingNested_ReportsActionableDiagnostic() {
        // The outer type resolves but the requested nested type is absent —
        // the binder must emit GS0268 ("does not contain a nested type")
        // pinned at the failing segment so the user understands which part
        // of the dotted name is wrong.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Outer
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

func Use() {
    var x Outer.Missing = nil
}`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0268") && d.Contains("Missing") && d.Contains("Outer"))
    }

    @Fact
    func SimpleIdentifier_TypeClauses_StillWork_RegressionGuard() {
        // Regression guard: existing single-identifier type clauses (locals,
        // parameters, returns, BCL names like `string`/`int32`) must
        // continue to work — the dotted-qualifier code path must not
        // accidentally swallow or mis-route plain names.
        let source = `package Probe
import System

func Echo(s string) string {
    return s
}

func Add(a int32, b int32) int32 {
    return a + b
}

var msg string = "hello"
Console.WriteLine(Echo(msg))
Console.WriteLine(Add(2, 3))`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}5${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue526_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue526_sib_").FullName
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
                // /reference: switches gsc to closed-world reference mode, so the
                // full BCL closure from the host's TPA must be enumerated as well.
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue526_err_").FullName
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
    }
}
