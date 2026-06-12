// <copyright file="Issue611SliceArrayParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #611: audit and close slice-vs-array surface gaps. These tests pin
/// the parity fixes introduced in this PR so regressions are caught early.
/// </summary>
public class Issue611SliceArrayParityTests
{
    // ---------------------------------------------------------------
    // Category (b) fix: type-parameter inference — slice → interface
    // ---------------------------------------------------------------

    [Fact]
    public void TypeInference_SlicePassedToClrGenericMethod_InfersT()
    {
        // Validates that slice → CLR generic method inference works end-to-end.
        // System.Linq.Enumerable.Count<T>(IEnumerable<T>) must infer T from a
        // []string argument. This exercises the CLR-level inference path
        // (OverloadResolution.UnifyForInference → FindClosedGeneric) which walks
        // the array's interfaces to find IEnumerable<string>.
        var gsource = """
            package Probe.Tests
            import System
            import System.Linq

            var s = []string{"a", "b", "c"}
            Console.WriteLine(Enumerable.Count(s))
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void TypeInference_SlicePassedToClrGenericMethod_Contains()
    {
        // Enumerable.Contains<T>(IEnumerable<T>, T) — two args, T inferred
        // from the slice element type.
        var gsource = """
            package Probe.Tests
            import System
            import System.Linq

            var s = []int32{10, 20, 30}
            Console.WriteLine(Enumerable.Contains(s, 20))
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void TypeInference_SlicePassedToClrGenericMethod_First()
    {
        // Enumerable.First<T>(IEnumerable<T>) infers T from slice element.
        var gsource = """
            package Probe.Tests
            import System
            import System.Linq

            var s = []string{"hello", "world"}
            Console.WriteLine(Enumerable.First(s))
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void TypeInference_GSharpGenericFunc_SliceParam_InfersT()
    {
        // A GSharp generic function with a []T parameter. The argument is a
        // []string literal (reference type avoids value-type array cast issues
        // in the type-erased model), so T infers to string. This exercises the
        // GSharp-level InferTypeArguments branch (SliceTypeSymbol ps &&
        // SliceTypeSymbol asym).
        var gsource = """
            package Probe.Tests
            import System
            import Gsharp.Extensions.Go

            func Size[T any](items []T) int32 {
                return len(items)
            }

            var s = []string{"a", "b", "c"}
            Console.WriteLine(Size(s))
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("3\n", output);
    }

    // ---------------------------------------------------------------
    // Category (b) fix: documentation ID — slice type encoding
    // ---------------------------------------------------------------

    [Fact]
    public void DocumentationId_SliceParam_MatchesArrayEncoding()
    {
        // Verify that compiling a function with a slice parameter does not
        // crash the documentation-ID provider. (The actual ID value is
        // checked at the unit level; this integration test ensures no
        // runtime failures.)
        var gsource = """
            package Probe.Tests
            import System

            func Sum(values []int32) int32 {
                var total = 0
                for _, v in values {
                    total = total + v
                }
                return total
            }

            Console.WriteLine(Sum([]int32{1, 2, 3}))
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("6\n", output);
    }

    // ---------------------------------------------------------------
    // Category (c) pin: intentional asymmetries (executable behavior)
    // ---------------------------------------------------------------

    [Fact]
    public void PatternMatch_ListPattern_WorksOnSlice()
    {
        // Pattern matching on slices already works (verified in #611
        // audit as category-a). Pin the behaviour.
        var gsource = """
            package Probe.Tests
            import System

            var s = []int32{1, 2, 3}
            let r = switch s { case [1, 2, 3]: "matched" default: "no match" }
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("matched\n", output);
    }

    [Fact]
    public void PatternMatch_ListPattern_WorksOnFixedArray()
    {
        // Pattern matching on fixed-arrays also works. Pin the behaviour.
        var gsource = """
            package Probe.Tests
            import System

            var a = [3]int32{1, 2, 3}
            let r = switch a { case [1, 2, 3]: "matched" default: "no match" }
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("matched\n", output);
    }

    [Fact]
    public void ForRange_Slice_YieldsElementsAndIndices()
    {
        // for-range on a slice — already correct, pinned here.
        var gsource = """
            package Probe.Tests
            import System

            var s = []string{"a", "b"}
            for i, v in s {
                Console.WriteLine(i.ToString() + ":" + v)
            }
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("0:a\n1:b\n", output);
    }

    [Fact]
    public void Intrinsic_Len_WorksOnSlice()
    {
        // len() on a slice — already correct, pinned here.
        var gsource = """
            package Probe.Tests
            import System
            import Gsharp.Extensions.Go

            var s = []int32{10, 20, 30, 40}
            Console.WriteLine(len(s))
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("4\n", output);
    }

    [Fact]
    public void Intrinsic_Len_WorksOnFixedArray()
    {
        // len() on a fixed-array — already correct, pinned here.
        var gsource = """
            package Probe.Tests
            import System
            import Gsharp.Extensions.Go

            var a = [2]int32{5, 6}
            Console.WriteLine(len(a))
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void SliceFieldStoredAs_IReadOnlyList_EmitsCorrectly()
    {
        // When a slice is stored in a field typed IReadOnlyList<T>,
        // the emitter must encode the field type as the interface, not
        // the array. Verify by round-tripping through a C# helper.
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Sink
                {
                    public static int Count(System.Collections.Generic.IReadOnlyList<int> items)
                    {
                        return items.Count;
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import System.Collections.Generic
            import Probe.CSharp

            var items IReadOnlyList[int32] = []int32{7, 8, 9}
            Console.WriteLine(Sink.Count(items))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("3\n", output);
    }

    // ---------------------------------------------------------------
    // Helpers — same pattern as Issue570 tests
    // ---------------------------------------------------------------

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue611_").FullName;
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

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var (exit, stdout, stderr, outPath, tempDir, siblingDll) =
            CompileWithSiblingCs(csSource, gSource, siblingName);

        try
        {
            Assert.True(
                exit == 0,
                $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");

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
            var runOut = proc.StandardOutput.ReadToEnd();
            var runErr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{runOut}\nstderr:\n{runErr}");

            return runOut.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int Exit, string Stdout, string Stderr, string OutPath, string TempDir, string SiblingDll)
        CompileWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue611_sib_").FullName;
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

        if (compileExit == 0)
        {
            File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true);
        }

        return (compileExit, compileOut.ToString(), compileErr.ToString(), outPath, tempDir, siblingDll);
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
