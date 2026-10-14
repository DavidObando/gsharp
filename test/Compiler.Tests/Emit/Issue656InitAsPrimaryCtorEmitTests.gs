// <copyright file="Issue656InitAsPrimaryCtorEmitTests.cs" company="GSharp">
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

/// Issue #656: a G# class that declares an explicit `init()` constructor
/// (with or without the `func` prefix) must emit a proper CLR `.ctor`
/// that executes the init body. Previously, `func init()` was silently
/// parsed as a regular method named "init", causing either GS9998 at compile
/// time or a NullReferenceException at runtime.
///
/// ADR-0065 §5 governs that the first declared designated init is the emitted
/// primary ctor when no primary-ctor parameter list is present.
///
/// Each test compiles via `gsc`, runs `ilverify`, then executes the
/// produced assembly under `dotnet exec` to assert end-to-end behavior.
open class Issue656InitAsPrimaryCtorEmitTests {
    // ====================================================================
    // Shape 1: CLR interface impl + parameterless init() (exact #656 repro)
    // ====================================================================
    @Fact
    func ExactIssueRepro_ClrInterface_FuncInit_CompilesAndRuns() {
        // Exact shape from issue #656: CLR interface + `func init()` + nullable record return
        let sibling = `#nullable enable
namespace Probe.CSharp
{
    public sealed record JobSnapshot(string Id);
    public interface IJobService
    {
        JobSnapshot? GetSnapshot(string jobId);
    }
}`
        let gsource = `package Probe.Tests
import Probe.CSharp
import System.Collections.Generic
import System

class FakeJobService : IJobService {
    var Active List[JobSnapshot]
    func init() {
        Active = List[JobSnapshot]()
    }
    func GetSnapshot(jobId string) JobSnapshot? {
        return nil
    }
}

var svc = FakeJobService()
Console.WriteLine(svc.Active.Count)
var snap = svc.GetSnapshot("x")
if snap == nil {
    Console.WriteLine("nil")
}`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("0${Environment.NewLine}nil${Environment.NewLine}", output)
    }

    @Fact
    func ClrInterface_BareInit_CompilesAndRuns() {
        // Same shape as above but with bare `init()` (no `func` prefix)
        let sibling = `#nullable enable
namespace Probe.CSharp
{
    public sealed record JobSnapshot(string Id);
    public interface IJobService
    {
        JobSnapshot? GetSnapshot(string jobId);
    }
}`
        let gsource = `package Probe.Tests
import Probe.CSharp
import System.Collections.Generic
import System

class FakeJobService : IJobService {
    var Active List[JobSnapshot]
    init() {
        Active = List[JobSnapshot]()
    }
    func GetSnapshot(jobId string) JobSnapshot? {
        return nil
    }
}

var svc = FakeJobService()
Console.WriteLine(svc.Active.Count)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("0${Environment.NewLine}", output)
    }

    // ====================================================================
    // Shape 2: parameterised init(a, b) + default-initialized fields
    // ====================================================================
    @Fact
    func ParameterisedInit_DefaultInitFields_CompilesAndRuns() {
        // Second shape from issue: init(title string, key string) with
        // default-initialized fields.
        let source = `package Probe
import System

class LifecycleTab {
    var Title string
    var Key string
    var Active bool = false
    func init(title string, key string) {
        Title = title
        Key = key
    }
}

var t = LifecycleTab("Settings", "settings")
Console.WriteLine(t.Title)
Console.WriteLine(t.Key)
Console.WriteLine(t.Active)`
        let output = CompileAndRun(source)
        Assert.Equal("Settings${Environment.NewLine}settings${Environment.NewLine}False${Environment.NewLine}", output)
    }

    // ====================================================================
    // Regression guard: explicit init() with NO interface
    // ====================================================================
    @Fact
    func ExplicitInit_NoInterface_CompilesAndRuns() {
        let source = `package Probe
import System

class Counter {
    var Value int32
    func init() {
        Value = 42
    }
}

var c = Counter()
Console.WriteLine(c.Value)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    // ====================================================================
    // Explicit init(args) taking parameters, NO primary-ctor list
    // ====================================================================
    @Fact
    func ExplicitInitWithParams_NoPrimaryCtorList_CompilesAndRuns() {
        let source = `package Probe
import System

class Greeting {
    var Message string
    func init(name string) {
        Message = "Hello, " + name + "!"
    }
}

var g = Greeting("world")
Console.WriteLine(g.Message)`
        let output = CompileAndRun(source)
        Assert.Equal("Hello, world!${Environment.NewLine}", output)
    }

    // ====================================================================
    // Explicit init() plus body-defined fields with = initializer (mixed)
    // ====================================================================
    @Fact
    func ExplicitInit_WithFieldInitializers_MixedStyle() {
        let source = `package Probe
import System

class Config {
    var Name string = "default"
    var Count int32
    func init() {
        Count = 7
    }
}

var cfg = Config()
Console.WriteLine(cfg.Name)
Console.WriteLine(cfg.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("default${Environment.NewLine}7${Environment.NewLine}", output)
    }

    // ====================================================================
    // ADR-0065 §5: class with primary-ctor parameter list AND explicit
    // init(args) — both coexist; primary becomes one designated init.
    // ====================================================================
    @Fact
    func PrimaryCtorAndExplicitInit_Coexist() {
        // ADR-0065 §5: a class may declare both a primary-constructor parameter
        // list and additional explicit `init(...)` bodies. The synthesized
        // primary ctor is one designated initializer; user-declared inits are
        // additional overloads, picked by overload resolution.
        let source = `package Probe
import System

class Dual(Name string) {
    var Age int32
    func init(age int32) {
        Age = age
    }
}

var byName = Dual("Alice")
var byAge = Dual(42)
Console.WriteLine(byName.Name)
Console.WriteLine(byAge.Age)`
        let output = CompileAndRun(source)
        Assert.Equal("Alice${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func PrimaryCtorAndExplicitInit_DuplicateSignatureReportsError() {
        // ADR-0065 §5: a user-written init with the same signature as the
        // synthesized primary-ctor init is a compile-time error.
        let source = `package Probe
import System

class Dup(Name string) {
    func init(other string) {
        Name = other
    }
}`
        let errors = CompileExpectingErrors(source)
        Assert.True(
            errors.Any((e string) -> e.Contains("GS0284") || (e.Contains("primary") && e.Contains("init"))),
            "Expected GS0284 (duplicates primary ctor): ${string.Join("\n", errors)}"
        )
    }

    // ====================================================================
    // Multiple explicit init overloads (ADR-0063 §9)
    // ====================================================================
    @Fact
    func MultipleInitOverloads_CompilesAndRuns() {
        let source = `package Probe
import System

class Color {
    var R int32
    var G int32
    var B int32
    init(r int32, g int32, b int32) {
        R = r
        G = g
        B = b
    }
    init(gray int32) {
        R = gray
        G = gray
        B = gray
    }
}

var red = Color(255, 0, 0)
var mid = Color(128)
Console.WriteLine(red.R)
Console.WriteLine(mid.G)`
        let output = CompileAndRun(source)
        Assert.Equal("255${Environment.NewLine}128${Environment.NewLine}", output)
    }

    // ====================================================================
    // func init with CLR interface and multiple fields assigned in body
    // ====================================================================
    @Fact
    func FuncInit_ClrInterface_MultipleFieldsAssigned() {
        let sibling = `#nullable enable
namespace Probe.CSharp
{
    public interface IRenderer
    {
        string Render(int width, int height);
    }
}`
        let gsource = `package Probe.Tests
import Probe.CSharp
import System

class TextRenderer : IRenderer {
    var Prefix string
    var Suffix string
    func init() {
        Prefix = "["
        Suffix = "]"
    }
    func Render(width int32, height int32) string {
        return Prefix + width.ToString() + "x" + height.ToString() + Suffix
    }
}

var r IRenderer = TextRenderer()
Console.WriteLine(r.Render(80, 24))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("[80x24]${Environment.NewLine}", output)
    }

    shared {
        // ====================================================================
        // Helpers
        // ====================================================================
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue656_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue656_err_").FullName
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
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue656_sib_").FullName
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
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>
    <NoWarn>$(NoWarn);CS1591</NoWarn>
    <DocumentationFile></DocumentationFile>
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
