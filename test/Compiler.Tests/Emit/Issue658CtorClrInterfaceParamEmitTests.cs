// <copyright file="Issue658CtorClrInterfaceParamEmitTests.cs" company="GSharp">
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
/// Issue #658: a G# class implementing a CLR interface must be passable
/// directly to a constructor or method parameter typed as that interface,
/// without requiring an explicit upcast or interface-typed local. Covers the
/// interaction with default-valued parameters (synthesized overload arity).
/// </summary>
public class Issue658CtorClrInterfaceParamEmitTests
{
    [Fact]
    public void CtorWithInterfaceParam_MultiArg_CompilesAndRuns()
    {
        // Exact repro from issue body: JobScheduler(IExecutor, int = 3).
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IExecutor { void Run(); }
                public sealed class JobScheduler
                {
                    private readonly IExecutor _executor;
                    private readonly int _retries;
                    public JobScheduler(IExecutor executor, int retries = 3)
                    {
                        _executor = executor;
                        _retries = retries;
                    }
                    public void Execute()
                    {
                        System.Console.WriteLine("retries=" + _retries);
                        _executor.Run();
                    }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class ProbeExecutor : IExecutor {
                func Run() {
                    Console.WriteLine("executed")
                }
            }

            let e = ProbeExecutor{}
            let s = JobScheduler(e, 5)
            s.Execute()
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("retries=5\nexecuted\n", output);
    }

    [Fact]
    public void CtorWithInterfaceParam_SingleArg_DefaultUsed()
    {
        // Single-argument call relying on default value.
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IExecutor { void Run(); }
                public sealed class JobScheduler
                {
                    private readonly int _retries;
                    public JobScheduler(IExecutor executor, int retries = 3)
                    {
                        _retries = retries;
                        executor.Run();
                    }
                    public int Retries => _retries;
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class ProbeExecutor : IExecutor {
                func Run() {
                    Console.WriteLine("ran")
                }
            }

            let e = ProbeExecutor{}
            let s = JobScheduler(e)
            Console.WriteLine(s.Retries)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("ran\n3\n", output);
    }

    [Fact]
    public void WorkaroundExplicitTypeAnnotation_StillWorks()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IExecutor { void Run(); }
                public sealed class JobScheduler
                {
                    public JobScheduler(IExecutor executor, int retries = 3)
                    {
                        executor.Run();
                    }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class ProbeExecutor : IExecutor {
                func Run() {
                    Console.WriteLine("annotated")
                }
            }

            let exe IExecutor = ProbeExecutor{}
            let s = JobScheduler(exe, 5)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("annotated\n", output);
    }

    [Fact]
    public void WorkaroundAsExpression_StillWorks()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IExecutor { void Run(); }
                public sealed class JobScheduler
                {
                    public JobScheduler(IExecutor executor, int retries = 3)
                    {
                        executor.Run();
                    }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class ProbeExecutor : IExecutor {
                func Run() {
                    Console.WriteLine("as-cast")
                }
            }

            let exe = ProbeExecutor{} as IExecutor
            let s = JobScheduler(exe, 5)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("as-cast\n", output);
    }

    [Fact]
    public void MethodCallWithInterfaceParam_CompilesAndRuns()
    {
        // Verify the same fix applies to regular method calls (not just ctors).
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IExecutor { void Run(); }
                public static class Runner
                {
                    public static void Launch(IExecutor executor, int times = 1)
                    {
                        for (int i = 0; i < times; i++)
                            executor.Run();
                    }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class ProbeExecutor : IExecutor {
                func Run() {
                    Console.WriteLine("go")
                }
            }

            let e = ProbeExecutor{}
            Runner.Launch(e, 2)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("go\ngo\n", output);
    }

    [Fact]
    public void MethodCallWithInterfaceParam_SingleArg_DefaultUsed()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IExecutor { void Run(); }
                public static class Runner
                {
                    public static void Launch(IExecutor executor, int times = 1)
                    {
                        for (int i = 0; i < times; i++)
                            executor.Run();
                    }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class ProbeExecutor : IExecutor {
                func Run() {
                    Console.WriteLine("single")
                }
            }

            let e = ProbeExecutor{}
            Runner.Launch(e)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("single\n", output);
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue658_sib_").FullName;
        try
        {
            // Step 1: compile the sibling C# library.
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

            // Step 2: compile the G# code referencing the sibling.
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
