// <copyright file="Issue656InitAsPrimaryCtorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #656: a G# class that declares an explicit <c>init()</c> constructor
/// (with or without the <c>func</c> prefix) must emit a proper CLR <c>.ctor</c>
/// that executes the init body. Previously, <c>func init()</c> was silently
/// parsed as a regular method named "init", causing either GS9998 at compile
/// time or a NullReferenceException at runtime.
///
/// ADR-0065 §5 governs that the first declared designated init is the emitted
/// primary ctor when no primary-ctor parameter list is present.
///
/// Each test compiles via <c>gsc</c>, runs <c>ilverify</c>, then executes the
/// produced assembly under <c>dotnet exec</c> to assert end-to-end behavior.
/// </summary>
public class Issue656InitAsPrimaryCtorEmitTests
{
    // ====================================================================
    // Shape 1: CLR interface impl + parameterless init() (exact #656 repro)
    // ====================================================================

    [Fact]
    public void ExactIssueRepro_ClrInterface_FuncInit_CompilesAndRuns()
    {
        // Exact shape from issue #656: CLR interface + `func init()` + nullable record return
        var sibling = """
            #nullable enable
            namespace Probe.CSharp
            {
                public sealed record JobSnapshot(string Id);
                public interface IJobService
                {
                    JobSnapshot? GetSnapshot(string jobId);
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import Probe.CSharp
            import System.Collections.Generic
            import System

            type FakeJobService class : IJobService {
                Active List[JobSnapshot]
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
            }
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("0\nnil\n", output);
    }

    [Fact]
    public void ClrInterface_BareInit_CompilesAndRuns()
    {
        // Same shape as above but with bare `init()` (no `func` prefix)
        var sibling = """
            #nullable enable
            namespace Probe.CSharp
            {
                public sealed record JobSnapshot(string Id);
                public interface IJobService
                {
                    JobSnapshot? GetSnapshot(string jobId);
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import Probe.CSharp
            import System.Collections.Generic
            import System

            type FakeJobService class : IJobService {
                Active List[JobSnapshot]
                init() {
                    Active = List[JobSnapshot]()
                }
                func GetSnapshot(jobId string) JobSnapshot? {
                    return nil
                }
            }

            var svc = FakeJobService()
            Console.WriteLine(svc.Active.Count)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("0\n", output);
    }

    // ====================================================================
    // Shape 2: parameterised init(a, b) + default-initialized fields
    // ====================================================================

    [Fact]
    public void ParameterisedInit_DefaultInitFields_CompilesAndRuns()
    {
        // Second shape from issue: init(title string, key string) with
        // default-initialized fields.
        var source = """
            package Probe
            import System

            type LifecycleTab class {
                Title string
                Key string
                Active bool = false
                func init(title string, key string) {
                    Title = title
                    Key = key
                }
            }

            var t = LifecycleTab("Settings", "settings")
            Console.WriteLine(t.Title)
            Console.WriteLine(t.Key)
            Console.WriteLine(t.Active)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Settings\nsettings\nFalse\n", output);
    }

    // ====================================================================
    // Regression guard: explicit init() with NO interface
    // ====================================================================

    [Fact]
    public void ExplicitInit_NoInterface_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            type Counter class {
                Value int32
                func init() {
                    Value = 42
                }
            }

            var c = Counter()
            Console.WriteLine(c.Value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    // ====================================================================
    // Explicit init(args) taking parameters, NO primary-ctor list
    // ====================================================================

    [Fact]
    public void ExplicitInitWithParams_NoPrimaryCtorList_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            type Greeting class {
                Message string
                func init(name string) {
                    Message = "Hello, " + name + "!"
                }
            }

            var g = Greeting("world")
            Console.WriteLine(g.Message)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Hello, world!\n", output);
    }

    // ====================================================================
    // Explicit init() plus body-defined fields with = initializer (mixed)
    // ====================================================================

    [Fact]
    public void ExplicitInit_WithFieldInitializers_MixedStyle()
    {
        var source = """
            package Probe
            import System

            type Config class {
                Name string = "default"
                Count int32
                func init() {
                    Count = 7
                }
            }

            var cfg = Config()
            Console.WriteLine(cfg.Name)
            Console.WriteLine(cfg.Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("default\n7\n", output);
    }

    // ====================================================================
    // ADR-0065 §5: class with primary-ctor parameter list AND explicit
    // init(args) — both coexist; primary becomes one designated init.
    // ====================================================================

    [Fact]
    public void PrimaryCtorAndExplicitInit_Coexist()
    {
        // ADR-0065 §5: a class may declare both a primary-constructor parameter
        // list and additional explicit `init(...)` bodies. The synthesized
        // primary ctor is one designated initializer; user-declared inits are
        // additional overloads, picked by overload resolution.
        var source = """
            package Probe
            import System

            type Dual class(Name string) {
                Age int32
                func init(age int32) {
                    Age = age
                }
            }

            var byName = Dual("Alice")
            var byAge = Dual(42)
            Console.WriteLine(byName.Name)
            Console.WriteLine(byAge.Age)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Alice\n42\n", output);
    }

    [Fact]
    public void PrimaryCtorAndExplicitInit_DuplicateSignatureReportsError()
    {
        // ADR-0065 §5: a user-written init with the same signature as the
        // synthesized primary-ctor init is a compile-time error.
        var source = """
            package Probe
            import System

            type Dup class(Name string) {
                func init(other string) {
                    Name = other
                }
            }
            """;

        var errors = CompileExpectingErrors(source);
        Assert.True(
            errors.Any(e => e.Contains("GS0284") || (e.Contains("primary") && e.Contains("init"))),
            $"Expected GS0284 (duplicates primary ctor): {string.Join("\n", errors)}");
    }

    // ====================================================================
    // Multiple explicit init overloads (ADR-0063 §9)
    // ====================================================================

    [Fact]
    public void MultipleInitOverloads_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            type Color class {
                R int32
                G int32
                B int32
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
            Console.WriteLine(mid.G)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("255\n128\n", output);
    }

    // ====================================================================
    // func init with CLR interface and multiple fields assigned in body
    // ====================================================================

    [Fact]
    public void FuncInit_ClrInterface_MultipleFieldsAssigned()
    {
        var sibling = """
            #nullable enable
            namespace Probe.CSharp
            {
                public interface IRenderer
                {
                    string Render(int width, int height);
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import Probe.CSharp
            import System

            type TextRenderer class : IRenderer {
                Prefix string
                Suffix string
                func init() {
                    Prefix = "["
                    Suffix = "]"
                }
                func Render(width int32, height int32) string {
                    return Prefix + width.ToString() + "x" + height.ToString() + Suffix
                }
            }

            var r IRenderer = TextRenderer()
            Console.WriteLine(r.Render(80, 24))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("[80x24]\n", output);
    }

    // ====================================================================
    // Helpers
    // ====================================================================

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue656_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue656_err_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");
            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue656_sib_").FullName;
        try
        {
            var csDir = Path.Combine(tempDir, "csref");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource);
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <AssemblyName>{siblingName}</AssemblyName>
                    <Nullable>enable</Nullable>
                    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
                    <EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>
                    <NoWarn>$(NoWarn);CS1591</NoWarn>
                    <DocumentationFile></DocumentationFile>
                  </PropertyGroup>
                </Project>
                """);

            var siblingDll = BuildCsProject(csDir, siblingName);

            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, gSource);

            var gscArgs = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + siblingDll,
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                gscArgs.Add("/reference:" + reference);
            }

            gscArgs.Add("/nowarn:GS9100");
            gscArgs.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(gscArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true);

            IlVerifier.Verify(outPath, additionalReferences: new[] { siblingDll });

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string BuildCsProject(string csDir, string siblingName)
    {
        RunDotnet(csDir, "restore");
        RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");
        var dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll");
        Assert.True(File.Exists(dll), $"sibling assembly not found at {dll}");
        return dll;
    }

    private static string RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(120_000), $"dotnet {args[0]} timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"dotnet {string.Join(" ", args)} failed (exit {proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
