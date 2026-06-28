// <copyright file="Issue569NestedTypeConstructionTests.cs" company="GSharp">
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
/// Issue #569: nested CLR types must be constructible via <c>Outer.Inner()</c>
/// in call/construction-expression position. The binder must unify the
/// call-expression resolution path with the type-clause path that #526 fixed,
/// so that <c>Outer.Inner(args)</c> binds as a constructor invocation when
/// <c>Inner</c> is a nested type of <c>Outer</c>.
/// </summary>
public class Issue569NestedTypeConstructionTests
{
    private const string InstanceOuterSiblingCs = """
        namespace Probe.CSharp
        {
            public class InstanceOuter
            {
                public class NestedFactory
                {
                    public int Value { get; set; }
                    public NestedFactory() { Value = 42; }
                    public NestedFactory(int v) { Value = v; }
                    public override string ToString() => $"NestedFactory({Value})";
                }
            }
        }
        """;

    private const string StaticOuterSiblingCs = """
        namespace Probe.CSharp
        {
            public static class StaticOuter
            {
                public class NestedFactory
                {
                    public int Value { get; set; }
                    public NestedFactory() { Value = 99; }
                    public NestedFactory(int v) { Value = v; }
                    public override string ToString() => $"NestedFactory({Value})";
                }
            }
        }
        """;

    private const string DeeplyNestedSiblingCs = """
        namespace Probe.CSharp
        {
            public class Outer
            {
                public class Middle
                {
                    public class Inner
                    {
                        public int N { get; }
                        public Inner() { N = 7; }
                        public Inner(int n) { N = n; }
                        public override string ToString() => $"Inner({N})";
                    }
                }
            }
        }
        """;

    [Fact]
    public void NestedType_InInstanceOuter_Constructs_CompilesAndRuns()
    {
        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            let f = InstanceOuter.NestedFactory()
            Console.WriteLine(f.Value)
            let g = InstanceOuter.NestedFactory(7)
            Console.WriteLine(g.Value)
            """;

        var output = CompileAndRunWithSiblingCs(InstanceOuterSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("42\n7\n", output);
    }

    [Fact]
    public void NestedType_InStaticOuter_Constructs_CompilesAndRuns()
    {
        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            let f = StaticOuter.NestedFactory()
            Console.WriteLine(f.Value)
            let g = StaticOuter.NestedFactory(5)
            Console.WriteLine(g.Value)
            """;

        var output = CompileAndRunWithSiblingCs(StaticOuterSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("99\n5\n", output);
    }

    [Fact]
    public void NestedType_Deeply_OuterMiddleInner_Constructs_CompilesAndRuns()
    {
        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            let a = Outer.Middle.Inner()
            Console.WriteLine(a.N)
            let b = Outer.Middle.Inner(123)
            Console.WriteLine(b.N)
            """;

        var output = CompileAndRunWithSiblingCs(DeeplyNestedSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("7\n123\n", output);
    }

    [Fact]
    public void NestedType_WithObjectInitializer_ConstructsAndSetsFields()
    {
        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            let f = InstanceOuter.NestedFactory() { Value = 55 }
            Console.WriteLine(f.Value)
            """;

        var output = CompileAndRunWithSiblingCs(InstanceOuterSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("55\n", output);
    }

    [Fact]
    public void NestedType_PassedAsArgumentToCtor_CompilesAndRuns()
    {
        // Construct a nested type and pass it directly as an argument
        // to another function — exercises the bound expression flowing
        // through the call-argument position.
        var sibling = """
            namespace Probe.CSharp
            {
                public class Container
                {
                    public class Payload
                    {
                        public int X { get; }
                        public Payload(int x) { X = x; }
                    }

                    public static int Extract(Payload p) => p.X;
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            let result = Container.Extract(Container.Payload(42))
            Console.WriteLine(result)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void NestedType_NonExistentInner_StillErrors_GS0159()
    {
        // A typo'd nested type name must still error (not silently pass).
        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            let f = InstanceOuter.Bogus()
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(InstanceOuterSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Contains(diagnostics, d => d.Contains("GS0159") || d.Contains("Cannot find function"));
    }

    [Fact]
    public void NestedType_AsTypeClause_StillWorks()
    {
        // Pin the #526 fix: nested type in type-clause position must
        // still resolve correctly.
        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var f InstanceOuter.NestedFactory = InstanceOuter.NestedFactory(10)
            Console.WriteLine(f.Value)
            """;

        var output = CompileAndRunWithSiblingCs(InstanceOuterSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("10\n", output);
    }

    [Fact]
    public void NestedType_AsBaseType_StillWorks()
    {
        // Pin the #526 fix: nested interface as base type must still work.
        var sibling = """
            namespace Probe.CSharp
            {
                public class Outer
                {
                    public interface INested
                    {
                        int Compute();
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            class Impl : Outer.INested {
                func Compute() int32 { return 77 }
            }

            var i Outer.INested = Impl{}
            Console.WriteLine(i.Compute())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("77\n", output);
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue569_sib_").FullName;
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
                    <Nullable>enable</Nullable>
                    <AssemblyName>{siblingName}</AssemblyName>
                    <RootNamespace>{siblingName}</RootNamespace>
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

    private static List<string> CompileExpectingErrorsWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue569_err_").FullName;
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
                    <Nullable>enable</Nullable>
                    <AssemblyName>{siblingName}</AssemblyName>
                    <RootNamespace>{siblingName}</RootNamespace>
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
                "/target:library",
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

            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");

            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
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
