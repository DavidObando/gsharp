// <copyright file="Issue573FieldSatisfiesGetterPropertyContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #573: a G# class with a public field whose name and type match a
/// getter-only CLR interface property should satisfy the interface contract.
/// Previously rejected with GS0187. The fix synthesizes a PropertySymbol
/// backed by the field at binding time.
/// </summary>
public class Issue573FieldSatisfiesGetterPropertyContractTests
{
    [Fact]
    public void FieldSatisfiesGetterOnlyProperty_BindsAndRuns()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IHasName
                {
                    string Name { get; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            type Impl1 class : IHasName {
                var Name string
            }

            var impl = Impl1{Name: "hello"}
            var iface IHasName = impl
            Console.WriteLine(iface.Name)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void FieldMutation_VisibleThroughInterfaceProperty()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IHasName
                {
                    string Name { get; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            type Impl1 class : IHasName {
                var Name string
            }

            var impl = Impl1{Name: "hello"}
            impl.Name = "world"
            var iface IHasName = impl
            Console.WriteLine(iface.Name)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("world\n", output);
    }

    [Fact]
    public void ExplicitPropertyAccessor_StillWorks()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IHasName
                {
                    string Name { get; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            type Impl2 class : IHasName {
                prop Name string { get { return "accessor" } }
            }

            var impl = Impl2{}
            var iface IHasName = impl
            Console.WriteLine(iface.Name)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("accessor\n", output);
    }

    [Fact]
    public void FieldSatisfiesReadWriteProperty_BindsAndRuns()
    {
        // #606: a field now satisfies a { get; set; } interface property.
        var sibling = """
            namespace ProbeRef
            {
                public interface IReadWrite
                {
                    string Value { get; set; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            type RWImpl class : IReadWrite {
                var Value string
            }

            var impl = RWImpl{Value: "initial"}
            var iface IReadWrite = impl
            Console.WriteLine(iface.Value)
            iface.Value = "updated"
            Console.WriteLine(iface.Value)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("initial\nupdated\n", output);
    }

    [Fact]
    public void ClassOmittingPropertyEntirely_StillReportsGS0187()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IHasName
                {
                    string Name { get; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            type NoImpl class : IHasName {
            }
            """;

        var errors = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Contains(errors, e => e.Contains("GS0187"));
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue573_sib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue573_err_").FullName;
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

    private static void RunDotnet(string workingDir, params string[] args)
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
