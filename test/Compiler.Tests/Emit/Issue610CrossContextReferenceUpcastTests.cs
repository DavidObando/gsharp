// <copyright file="Issue610CrossContextReferenceUpcastTests.cs" company="GSharp">
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
/// Issue #610: generalize cross-context reference upcast (follow-up to 6.5 / #570).
///
/// PR #612 (6.5) added a dedicated <c>SliceTypeSymbol → interface</c> arm in
/// <c>Conversion.Classify</c> and a cross-context <c>ImplementsInterfaceByName</c>
/// helper to bridge the live-runtime ↔ MetadataLoadContext type-assembly mismatch.
/// That fix was narrow — only for slices.
///
/// This issue generalizes the fix to ALL CLR reference upcasts by promoting the
/// cross-context interface/base-class walk into <c>ClrTypeUtilities.IsAssignableByName</c>.
/// The dedicated slice arm is refactored into a combined slice-to-interface block that
/// also enforces slice invariance.
///
/// Each test compiles with explicit <c>/reference:</c> paths (triggering
/// MetadataLoadContext mode) to exercise the cross-context boundary where the
/// source type's CLR backing lives in the live runtime and the target type is
/// loaded from MLC reference assemblies.
/// </summary>
public class Issue610CrossContextReferenceUpcastTests
{
    // ─────────────────────────────────────────────────────────────────────
    // Positive: Built-in string → BCL interface (cross-context)
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void UserClass_ImplementingBCLInterface_UpcastAcrossContexts_Works()
    {
        // A string literal (TypeSymbol.String, live-runtime ClrType) is
        // passed to a sibling C# method parameter typed as IComparable
        // (resolved from MLC reference assemblies). This exercises the
        // cross-context gap fixed by promoting ImplementsInterfaceByName
        // into the general IsAssignableByName fallback.
        var sibling = """
            namespace CrossCtx
            {
                public static class Helper
                {
                    public static string CompareStuff(System.IComparable c)
                    {
                        return c.CompareTo("zzz") < 0 ? "less" : "geq";
                    }
                }
            }
            """;

        var gsource = """
            package P
            import System
            import CrossCtx

            var result = Helper.CompareStuff("hello")
            Console.WriteLine(result)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "CrossCtx");
        Assert.Equal("less\n", output);
    }

    [Fact]
    public void UserClass_ImplementingCustomCLRInterface_UpcastAcrossContexts_Works()
    {
        // A sibling C# assembly defines IProcessor and StringProcessor.
        // G# creates a StringProcessor and assigns to IProcessor — both
        // types come from MLC (same context), but the assignment exercises
        // the Conversion.Classify path.
        var sibling = """
            namespace CustomIface
            {
                public interface IProcessor
                {
                    string Process(string input);
                }

                public class StringProcessor : IProcessor
                {
                    public string Process(string input)
                    {
                        return input.ToUpper();
                    }
                }
            }
            """;

        var gsource = """
            package P
            import System
            import CustomIface

            var p IProcessor = StringProcessor()
            Console.WriteLine(p.Process("hello"))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "CustomIface");
        Assert.Equal("HELLO\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Built-in string → BCL interface via assignment (cross-ctx)
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void String_AssignedTo_IComparable_CrossContext()
    {
        // Direct variable assignment: var x IComparable = "hello"
        // The string's ClrType is live-runtime typeof(string), while
        // IComparable is resolved from MLC reference assemblies.
        var sibling = """
            namespace Trigger
            {
                public static class Dummy { public static string Noop() { return "ok"; } }
            }
            """;

        var gsource = """
            package P
            import System
            import Trigger

            var x IComparable = "hello"
            Console.WriteLine(x.CompareTo("world") < 0)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Trigger");
        Assert.Equal("True\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Generic constructed type arg across contexts
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Generic_ConstructedTypeArg_Across_Contexts_Works()
    {
        // A sibling C# method accepts IEnumerable<string>. G# passes a
        // List[string] which is constructed in MLC context. Both sides are
        // MLC, so this tests the same-context path still works after refactor.
        var sibling = """
            namespace GenCtx
            {
                public static class Counter
                {
                    public static int Count(System.Collections.Generic.IEnumerable<string> items)
                    {
                        int n = 0;
                        foreach (var _ in items) n++;
                        return n;
                    }
                }
            }
            """;

        var gsource = """
            package P
            import System
            import System.Collections.Generic
            import GenCtx

            var list = List[string]()
            list.Add("a")
            list.Add("b")
            list.Add("c")
            Console.WriteLine(Counter.Count(list))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "GenCtx");
        Assert.Equal("3\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Slice → interface regression guard (#570)
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Slice_StillConvertsToInterface_RegressionGuard()
    {
        // The #570 shape must still work after subsuming the dedicated
        // slice arm: []string passed to a C# method taking IEnumerable<string>.
        var sibling = """
            namespace SliceGuard
            {
                public static class Sink
                {
                    public static int Count(System.Collections.Generic.IEnumerable<string> items)
                    {
                        int n = 0;
                        foreach (var _ in items) n++;
                        return n;
                    }
                }
            }
            """;

        var gsource = """
            package P
            import System
            import SliceGuard

            var n = Sink.Count([]string{"x", "y"})
            Console.WriteLine(n)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "SliceGuard");
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void Slice_AssignedToInterface_RegressionGuard()
    {
        // Slice assigned to IReadOnlyList variable (cross-context: slice
        // ClrType is live-runtime string[], target is MLC IReadOnlyList).
        var sibling = """
            namespace SliceAssign
            {
                public static class Dummy { public static string Noop() { return "ok"; } }
            }
            """;

        var gsource = """
            package P
            import System
            import System.Collections.Generic
            import SliceAssign

            var items IReadOnlyList[string] = []string{"alpha", "beta"}
            Console.WriteLine(items[0])
            Console.WriteLine(items.Count)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "SliceAssign");
        Assert.Equal("alpha\n2\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Method return widening across contexts
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void MethodReturn_WidensStringToInterface_CrossContext()
    {
        // A G# function returning IComparable returns a string literal.
        var sibling = """
            namespace RetWiden
            {
                public static class Dummy { public static string Noop() { return "ok"; } }
            }
            """;

        var gsource = """
            package P
            import System
            import RetWiden

            func GetComparable() IComparable {
                return "abc"
            }

            var c = GetComparable()
            Console.WriteLine(c.CompareTo("zzz") < 0)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "RetWiden");
        Assert.Equal("True\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Negative: Incompatible cross-context shapes produce errors
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Negative_UnrelatedTypeToInterface_Errors()
    {
        // A class that does NOT implement the target interface must still
        // produce a diagnostic.
        var sibling = """
            namespace NegCtx
            {
                public interface IFoo
                {
                    void DoFoo();
                }

                public class Bar
                {
                }
            }
            """;

        var gsource = """
            package P
            import NegCtx

            var x IFoo = Bar()
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "NegCtx");
        Assert.Contains(diagnostics, d => d.Contains("GS0155") || d.Contains("Cannot convert"));
    }

    [Fact]
    public void Negative_SliceCovariance_StillBlocked()
    {
        // Slice invariance: []string must NOT convert to IEnumerable<object>
        // even though CLR arrays are covariant. This pins the invariance guard.
        var sibling = """
            namespace NegSlice
            {
                public static class Dummy { public static string Noop() { return "ok"; } }
            }
            """;

        var gsource = """
            package P
            import System.Collections.Generic
            import NegSlice

            var items IEnumerable[object] = []string{"hello"}
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "NegSlice");
        Assert.Contains(diagnostics, d => d.Contains("GS0155") || d.Contains("Cannot convert"));
    }

    [Fact]
    public void Negative_IntToInterface_ValueType_NotReference()
    {
        // A value type (int32) to interface is a boxing conversion, not
        // a reference upcast. This should compile (boxing is implicit),
        // but verifies the correct code path is used (not the reference arm).
        var sibling = """
            namespace NegVt
            {
                public static class Helper
                {
                    public static string Describe(System.IComparable c)
                    {
                        return c.ToString();
                    }
                }
            }
            """;

        var gsource = """
            package P
            import System
            import NegVt

            Console.WriteLine(Helper.Describe(42))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "NegVt");
        Assert.Equal("42\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue610_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue610_neg_").FullName;
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
                "/nowarn:GS9100",
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                gscArgs.Add("/reference:" + reference);
            }

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
                compileExit != 0,
                $"expected gsc to report errors but it succeeded\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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
