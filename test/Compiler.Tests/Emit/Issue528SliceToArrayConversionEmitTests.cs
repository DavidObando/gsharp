// <copyright file="Issue528SliceToArrayConversionEmitTests.cs" company="GSharp">
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
/// Issue #528: a G# slice value <c>[]T</c> did not implicitly convert to a CLR
/// array <c>T[]</c>, so it could not be assigned to a CLR property/field of
/// type <c>T[]</c> nor passed as a parameter of type <c>T[]</c>. The binder
/// rejected the assignment with <c>GS0155: Cannot convert type '[]string' to
/// 'System.String[]'.</c> The spec is explicit that "slices are backed by CLR
/// arrays", so this direction must be implicit and a no-op at the CLR / IL
/// level — the runtime representation of a slice already is a one-dimensional
/// zero-based <c>T[]</c>. The reverse direction (CLR array → slice) already
/// worked; the regression guard below pins it.
/// </summary>
public class Issue528SliceToArrayConversionEmitTests
{
    [Fact]
    public void SliceLiteral_AssignsTo_ClrArrayProperty()
    {
        // The exact issue-body repro: a slice literal assigned to a C#
        // property typed `string[]`. Before the fix this reported
        // `GS0155 Cannot convert type '[]string' to 'System.String[]'`.
        var sibling = """
            namespace Probe.CSharp
            {
                public sealed class LibraryItem
                {
                    public string[] Authors { get; set; } = System.Array.Empty<string>();
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var item = LibraryItem()
            item.Authors = []string{"Andy Weir"}
            Console.WriteLine(item.Authors.Length)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void SliceLiteral_AssignsTo_ClrArrayField()
    {
        // Same conversion through a CLR public field rather than a property.
        // Catches a regression where the fix would route only through property
        // setters and miss field stores.
        var sibling = """
            namespace Probe.CSharp
            {
                public sealed class LibraryItem
                {
                    public string[] AuthorsField = System.Array.Empty<string>();
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var item = LibraryItem()
            item.AuthorsField = []string{"a", "b", "c"}
            Console.WriteLine(item.AuthorsField.Length)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void SliceArgument_PassedTo_ClrMethodWithArrayParameter()
    {
        // A `[]int32` slice passed as a `int[]` parameter to a CLR method.
        // Confirms element-type identity for value-typed elements (G# int32
        // ↔ CLR System.Int32) and the conversion rule applies to argument
        // position, not just assignment.
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Sink
                {
                    public static int Sum(int[] xs)
                    {
                        int s = 0;
                        foreach (var x in xs)
                        {
                            s += x;
                        }

                        return s;
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var nums = []int32{1, 2, 3, 4}
            Console.WriteLine(Sink.Sum(nums))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("10\n", output);
    }

    [Fact]
    public void SliceReturned_FromGSharpFunctionLiteral_ToClrDelegateReturningArray()
    {
        // The implicit slice → array conversion must apply in return position
        // too. A G# `func` literal returning `[]string` is assigned to a CLR
        // `Func<string[]>` delegate-typed parameter, and the C# callee invokes
        // it and reads the array back. This is the "return a slice from a
        // function whose return type is `T[]`" scenario from the issue,
        // expressed through a delegate (G# can declare slice return types
        // syntactically but not CLR-array return types).
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Caller
                {
                    public static int InvokeAndCount(System.Func<string[]> maker)
                    {
                        var arr = maker();
                        return arr.Length;
                    }

                    public static string InvokeAndPick(System.Func<string[]> maker, int index)
                    {
                        return maker()[index];
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var n = Caller.InvokeAndCount(func() []string { return []string{"a", "b", "c"} })
            Console.WriteLine(n)
            Console.WriteLine(Caller.InvokeAndPick(func() []string { return []string{"alpha", "beta", "gamma"} }, 1))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("3\nbeta\n", output);
    }

    [Fact]
    public void RoundTrip_Slice_To_Array_To_Slice_PreservesLength()
    {
        // Round-trip: a G# slice is handed to a C# helper that takes a
        // `string[]` parameter and returns the same `string[]`. The returned
        // CLR array is then bound back to a G# `[]string` slice. Both
        // conversions are implicit and the round-tripped length matches the
        // original. (G# has no syntax for a CLR array TYPE-CLAUSE locally, so
        // the array round-trips through a C# helper.)
        var sibling = """
            namespace Probe.CSharp
            {
                public static class RoundTripHelper
                {
                    public static string[] Echo(string[] xs)
                    {
                        return xs;
                    }

                    public static int LengthOf(string[] xs)
                    {
                        return xs.Length;
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var slice = []string{"x", "y", "z"}
            var slice2 []string = RoundTripHelper.Echo(slice)
            Console.WriteLine(slice.Length)
            Console.WriteLine(slice2.Length)
            Console.WriteLine(RoundTripHelper.LengthOf(slice))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("3\n3\n3\n", output);
    }

    [Fact]
    public void ClrArray_FromMethod_ConvertsImplicitlyTo_Slice_RegressionGuard()
    {
        // Regression guard for the reverse direction (CLR array → slice),
        // which already worked before this PR. A C# method returns `int[]`
        // and the result binds to a G# `[]int32` slice variable; range/append
        // must continue to work on it.
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Maker
                {
                    public static int[] Range(int n)
                    {
                        var r = new int[n];
                        for (int i = 0; i < n; i++)
                        {
                            r[i] = i;
                        }

                        return r;
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var s []int32 = Maker.Range(4)
            var total int32 = 0
            for _, v := range s {
                total = total + v
            }

            Console.WriteLine(total)
            Console.WriteLine(len(s))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("6\n4\n", output);
    }

    [Fact]
    public void SliceVariance_StringToObjectArray_StillRejected()
    {
        // Variance regression guard: G# slices are invariant in their
        // element type, and the new slice → CLR array rule must follow the
        // same invariance. `[]string → object[]` is therefore not implicit
        // (even though the CLR would allow the reference upcast). If a
        // future spec relaxes this, the test should be updated explicitly.
        var sibling = """
            namespace Probe.CSharp
            {
                public sealed class Bag
                {
                    public object[] Items { get; set; } = System.Array.Empty<object>();
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var b = Bag()
            b.Items = []string{"a"}
            """;

        var diags = CompileAndCollectDiagnosticsWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Contains("GS0155", diags);
    }

    [Fact]
    public void SliceToSlice_Assignment_StillWorks_RegressionGuard()
    {
        // Slice → slice (same element type) was already identity; ensure the
        // new branch did not perturb that path.
        var gsource = """
            package Probe.Tests
            import System

            var a = []int32{1, 2, 3}
            var b []int32 = a
            Console.WriteLine(len(b))
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue528_").FullName;
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

    private static string CompileAndCollectDiagnosticsWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var (_, stdout, stderr, _, tempDir, _) = CompileWithSiblingCs(csSource, gSource, siblingName);
        try
        {
            return stdout + "\n" + stderr;
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int Exit, string Stdout, string Stderr, string OutPath, string TempDir, string SiblingDll)
        CompileWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue528_sib_").FullName;
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

        var stdout = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");
        _ = stdout;

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
