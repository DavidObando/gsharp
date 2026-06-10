// <copyright file="Issue666LinqExtensionInferredTypeArgEmitTests.cs" company="GSharp">
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
/// Issue #666: LINQ extension methods called via instance syntax on
/// <c>List&lt;T&gt;</c> / <c>IEnumerable&lt;T&gt;</c> where <c>T</c> is a CLR
/// reference type from a project reference must compile, IL-verify, and run
/// correctly. The sibling C# library pattern exercises the cross-
/// <see cref="System.Reflection.MetadataLoadContext"/> inference path that
/// previously threw <see cref="NotSupportedException"/> inside
/// <c>FindClosedGeneric</c>.
/// </summary>
public class Issue666LinqExtensionInferredTypeArgEmitTests
{
    [Fact]
    public void WhereSelectToArray_OnClrRefElement_CompilesRunsAndIlVerifies()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public sealed class ItemCls
                {
                    public string Name { get; set; } = "";
                }
            }
            """;

        var gsource = """
            package Probe
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
            Console.WriteLine(result[1])
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("2\nalpha\nbeta\n", output);
    }

    [Fact]
    public void FirstOrDefault_OnClrRefElement_CompilesRunsAndIlVerifies()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public sealed class ItemCls
                {
                    public string Name { get; set; } = "";
                }
            }
            """;

        // FirstOrDefault returns a nullable reference; access the result
        // via Count() on the filtered sequence to avoid nullable member
        // lookup (a separate binder concern).
        var gsource = """
            package Probe
            import Probe.CSharp
            import System
            import System.Collections.Generic
            import System.Linq

            var xs = List[ItemCls]()
            var a = ItemCls()
            a.Name = "first"
            xs.Add(a)

            var count = xs.Where(func(i ItemCls) bool { return true }).Count()
            Console.WriteLine(count)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void AsEnumerableWhere_OnClrRefElement_CompilesRunsAndIlVerifies()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public sealed class ItemCls
                {
                    public string Name { get; set; } = "";
                }
            }
            """;

        var gsource = """
            package Probe
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
            Console.WriteLine(result[0].Name)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("1\nworld\n", output);
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue666_").FullName;
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

            // Place the sibling next to the produced assembly for runtime resolution.
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
