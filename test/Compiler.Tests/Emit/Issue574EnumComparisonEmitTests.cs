// <copyright file="Issue574EnumComparisonEmitTests.cs" company="GSharp">
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
/// Issue #574 ("same family as #534"): the equality (== / !=) and ordering
/// (&lt; / &lt;= / &gt; / &gt;=) operators must be defined for CLR enum
/// types, mirroring the bitwise lowering shipped in PR #562. Previously
/// the binder only matched user-defined <c>EnumSymbol == EnumSymbol</c>;
/// imported BCL enums (which surface as <c>ImportedTypeSymbol</c> whose
/// <c>ClrType.IsEnum</c>) tripped <c>GS0129 Binary operator '==' is not
/// defined …</c>.
///
/// These tests pin the new behaviour:
/// <list type="bullet">
///   <item><c>==</c> / <c>!=</c> on imported BCL enums
///   (<c>ConsoleKey</c>, <c>FileShare</c>) and on a user-defined C# probe
///   enum.</item>
///   <item><c>&lt;</c> / <c>&lt;=</c> / <c>&gt;</c> / <c>&gt;=</c> on
///   signed-backed (int32) and unsigned-backed (byte) enums, the latter
///   exercising the <c>clt_un</c> / <c>cgt_un</c> dispatch path.</item>
///   <item>Regression: the user-defined <c>EnumSymbol == EnumSymbol</c> arm
///   still works (it now flows through the same generalized <c>IsEnumType</c>
///   helper).</item>
///   <item>Negative: mixed-enum <c>==</c> and enum + int <c>==</c> still
///   produce diagnostics.</item>
/// </list>
/// Each test compiles via <c>gsc</c>, runs <c>ilverify</c> against the
/// produced PE, then executes the assembly under <c>dotnet exec</c> and
/// asserts on the captured stdout.
/// </summary>
public class Issue574EnumComparisonEmitTests
{
    // ── Positive: imported BCL enum equality ────────────────────────────

    [Fact]
    public void ConsoleKey_Equality_True()
    {
        var source = """
            package P
            import System

            var k = ConsoleKey.L
            Console.WriteLine(k == ConsoleKey.L)
            Console.WriteLine(k != ConsoleKey.L)
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void ConsoleKey_Equality_False()
    {
        var source = """
            package P
            import System

            var k = ConsoleKey.L
            Console.WriteLine(k == ConsoleKey.A)
            Console.WriteLine(k != ConsoleKey.A)
            """;

        Assert.Equal("False\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void FileShare_Equality_RoundTrips()
    {
        var source = """
            package P
            import System
            import System.IO

            var a = FileShare.Read
            var b = FileShare.Read
            var c = FileShare.Write
            Console.WriteLine(a == b)
            Console.WriteLine(a == c)
            Console.WriteLine(a != c)
            """;

        Assert.Equal("True\nFalse\nTrue\n", CompileAndRun(source));
    }

    // ── Positive: ordering on signed-backed (int) CLR enum ─────────────

    [Fact]
    public void ConsoleKey_Ordering_Less()
    {
        var source = """
            package P
            import System

            var a = ConsoleKey.A
            var b = ConsoleKey.B
            Console.WriteLine(a < b)
            Console.WriteLine(b < a)
            Console.WriteLine(a <= a)
            """;

        Assert.Equal("True\nFalse\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void ConsoleKey_Ordering_Greater()
    {
        var source = """
            package P
            import System

            var a = ConsoleKey.A
            var b = ConsoleKey.B
            Console.WriteLine(b > a)
            Console.WriteLine(a > b)
            Console.WriteLine(b >= b)
            """;

        Assert.Equal("True\nFalse\nTrue\n", CompileAndRun(source));
    }

    // ── Positive: ordering on unsigned-backed (byte) enum — exercises clt_un / cgt_un ──

    [Fact]
    public void ByteBackedEnum_Ordering_UnsignedSemantics()
    {
        var csSource = """
            using System;

            namespace Probe574
            {
                public enum SmallEnum : byte
                {
                    A = 1,
                    B = 200,
                }
            }
            """;

        var gsSource = """
            package P
            import System
            import Probe574

            var a = SmallEnum.A
            var b = SmallEnum.B
            Console.WriteLine(a < b)
            Console.WriteLine(b > a)
            Console.WriteLine(a <= a)
            Console.WriteLine(b >= b)
            Console.WriteLine(b == SmallEnum.B)
            Console.WriteLine(b != a)
            """;

        Assert.Equal(
            "True\nTrue\nTrue\nTrue\nTrue\nTrue\n",
            CompileAndRunWithSiblingCs(csSource, gsSource, "Probe574"));
    }

    // ── Positive: user-defined G# enum equality (regression) ─────────────

    [Fact]
    public void UserDefinedGSharpEnum_EqualityStillWorks()
    {
        var source = """
            package P
            import System

            type Color enum {
                Red,
                Green,
                Blue,
            }

            var c = Color.Green
            Console.WriteLine(c == Color.Green)
            Console.WriteLine(c == Color.Red)
            Console.WriteLine(c != Color.Red)
            """;

        Assert.Equal("True\nFalse\nTrue\n", CompileAndRun(source));
    }

    // ── Positive: user-defined G# enum ordering ─────────────────────────

    [Fact]
    public void UserDefinedGSharpEnum_Ordering()
    {
        var source = """
            package P
            import System

            type Color enum {
                Red,
                Green,
                Blue,
            }

            var r = Color.Red
            var g = Color.Green
            var b = Color.Blue
            Console.WriteLine(r < g)
            Console.WriteLine(g < b)
            Console.WriteLine(b > r)
            Console.WriteLine(g >= g)
            Console.WriteLine(r <= g)
            """;

        Assert.Equal("True\nTrue\nTrue\nTrue\nTrue\n", CompileAndRun(source));
    }

    // ── Negative: mixed-enum equality is still rejected ─────────────────

    [Fact]
    public void MixedEnumTypes_Equality_ProducesDiagnostic()
    {
        var source = """
            package P
            import System
            import System.IO

            var bad = FileShare.Read == FileAccess.Read
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("'=='") && d.Contains("FileShare") && d.Contains("FileAccess"));
    }

    // ── Negative: enum + integer equality is still rejected ─────────────

    [Fact]
    public void EnumAndInt_Equality_ProducesDiagnostic()
    {
        var source = """
            package P
            import System
            import System.IO

            var bad = FileShare.Read == 1
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("'=='") && d.Contains("FileShare"));
    }

    // ── Helpers ────────────────────────────────────────────────────────

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue574_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue574_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit != 0, $"expected gsc to report errors but it succeeded\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue574_sib_").FullName;
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

            foreach (var reference in BclReferences.Value)
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

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
