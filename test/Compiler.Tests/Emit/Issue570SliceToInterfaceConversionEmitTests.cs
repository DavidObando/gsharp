// <copyright file="Issue570SliceToInterfaceConversionEmitTests.cs" company="GSharp">
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
/// Issue #570: a G# slice value <c>[]T</c> did not implicitly convert to the
/// interfaces implemented by its backing CLR array <c>T[]</c>, such as
/// <c>IEnumerable&lt;T&gt;</c>, <c>IReadOnlyList&lt;T&gt;</c>,
/// <c>IList&lt;T&gt;</c>, etc. The binder rejected the assignment with
/// <c>GS0154: Parameter '…' requires a value of type 'IEnumerable&lt;string&gt;'
/// but was given a value of type '[]string'.</c> The spec states that "slices
/// are backed by CLR arrays", so every interface a CLR <c>T[]</c> implements
/// must be reachable from a <c>[]T</c> via an implicit, no-op conversion. The
/// fix adds a dedicated arm in <c>Conversion.Classify</c> that walks the
/// array's interface set by name (cross-MLC safe via
/// <c>ClrTypeUtilities.ImplementsInterfaceByName</c>).
/// </summary>
public class Issue570SliceToInterfaceConversionEmitTests
{
    [Fact]
    public void SliceLiteral_PassedAs_IEnumerableOfT()
    {
        // The issue body's primary repro: a []string slice literal is
        // passed to a C# method taking IEnumerable<string>.
        var sibling = """
            namespace Probe.CSharp
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
            package Probe.Tests
            import System
            import Probe.CSharp

            var n = Sink.Count([]string{"a", "b"})
            Console.WriteLine(n)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void SliceLiteral_PassedAs_IReadOnlyListOfT()
    {
        // IReadOnlyList<T> — the most commonly-requested interface target
        // from the issue discussion.
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Sink
                {
                    public static int CountViaRoList(System.Collections.Generic.IReadOnlyList<string> items)
                    {
                        return items.Count;
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var n = Sink.CountViaRoList([]string{"x", "y"})
            Console.WriteLine(n)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void SliceLiteral_PassedAs_IListOfT()
    {
        // IList<T> — confirms the slice can satisfy a mutable-list interface.
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Sink
                {
                    public static string ReadFirst(System.Collections.Generic.IList<string> items)
                    {
                        return items[0];
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            Console.WriteLine(Sink.ReadFirst([]string{"hello", "world"}))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void SliceLiteral_PassedAs_ICollectionOfT()
    {
        // ICollection<T>.Count property.
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Sink
                {
                    public static int CountViaCollection(System.Collections.Generic.ICollection<string> items)
                    {
                        return items.Count;
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            Console.WriteLine(Sink.CountViaCollection([]string{"a", "b", "c"}))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void SliceLiteral_PassedAs_IReadOnlyCollectionOfT()
    {
        // IReadOnlyCollection<T>.Count property.
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Sink
                {
                    public static int CountViaRoCollection(System.Collections.Generic.IReadOnlyCollection<string> items)
                    {
                        return items.Count;
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            Console.WriteLine(Sink.CountViaRoCollection([]string{"a", "b", "c", "d"}))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("4\n", output);
    }

    [Fact]
    public void SliceLiteral_PassedAs_NonGenericIEnumerable()
    {
        // Non-generic IEnumerable — arrays implement it too.
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Sink
                {
                    public static int CountViaPlainEnumerable(System.Collections.IEnumerable items)
                    {
                        int n = 0;
                        foreach (var _ in items) n++;
                        return n;
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            Console.WriteLine(Sink.CountViaPlainEnumerable([]string{"a", "b", "c"}))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void SliceLiteral_PassedAs_SystemObject_SmokeTest()
    {
        // Slice → System.Object already worked via the line-282 rule;
        // smoke test that the new arm doesn't conflict.
        var gsource = """
            package Probe.Tests
            import System

            func takeObj(o object) string { return o.ToString() ?? "" }
            Console.WriteLine(takeObj([]int32{1, 2, 3}).StartsWith("System.Int32"))
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void SliceLiteral_AssignedToProperty_TypedIReadOnlyListOfT()
    {
        // Same as the #528 property-assignment test but for an interface target.
        var sibling = """
            namespace Probe.CSharp
            {
                public sealed class Container
                {
                    public System.Collections.Generic.IReadOnlyList<string> Items { get; set; }
                        = System.Array.Empty<string>();
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var c = Container()
            c.Items = []string{"alpha", "beta"}
            Console.WriteLine(c.Items.Count)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void SliceInvariance_StringToIListOfObject_StillRejected()
    {
        // IList<T> is invariant and mutable. CLR array covariance must not
        // bypass G#'s exact-element requirement for this interface.
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Sink
                {
                    public static int CountObjects(System.Collections.Generic.IList<object> items)
                        => items.Count;
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import Probe.CSharp

            Sink.CountObjects([]string{"a"})
            """;

        var diags = CompileAndCollectDiagnosticsWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        // Rejected either as GS0154 (wrong argument type) or GS0159
        // (cannot find function — overload resolution rejects the candidate
        // because the invariant generic-arg check blocks array covariance).
        Assert.True(
            diags.Contains("GS0154") || diags.Contains("GS0159"),
            $"Expected GS0154 or GS0159 but got:\n{diags}");
    }

    [Fact]
    public void SliceLiteral_PassedAs_IReadOnlyListOfString_ViaGSharpFunc()
    {
        // Real-world repro shape: a G# function taking IReadOnlyList<string>
        // receives a []string literal (mirrors System.CommandLine.Command.Parse
        // scenario from issue body).
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Parser
                {
                    public static string ParseFirst(System.Collections.Generic.IReadOnlyList<string> args)
                    {
                        return args.Count > 0 ? args[0] : "<empty>";
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            Console.WriteLine(Parser.ParseFirst([]string{"--help", "--verbose"}))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("--help\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue570_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue570_sib_").FullName;
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
