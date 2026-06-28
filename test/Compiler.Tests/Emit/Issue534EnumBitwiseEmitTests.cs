// <copyright file="Issue534EnumBitwiseEmitTests.cs" company="GSharp">
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
/// Issue #534: bitwise operators |, &amp;, ^, and unary ^ (ones complement)
/// must be defined for CLR enum types. Tests cover imported BCL enums
/// (FileShare, FileAccess, RegexOptions, UnixFileMode), a user-defined C#
/// probe enum with [Flags] and long underlying type, regression guards for
/// existing int32/bool operators, and negative tests for mixed-enum and
/// enum+int operand combinations.
/// </summary>
public class Issue534EnumBitwiseEmitTests
{
    // ── Positive: CLR enum bitwise OR ────────────────────────────────

    [Fact]
    public void FileShare_BitwiseOr_ProducesCorrectValue()
    {
        var source = """
            package P
            import System
            import System.IO

            var mode = FileShare.ReadWrite | FileShare.Delete
            Console.WriteLine(int32(mode))
            """;

        // FileShare.ReadWrite = 3, FileShare.Delete = 4 → 3 | 4 = 7
        Assert.Equal("7\n", CompileAndRun(source));
    }

    // ── Positive: CLR enum bitwise AND ───────────────────────────────

    [Fact]
    public void FileAccess_BitwiseAnd_ProducesCorrectValue()
    {
        var source = """
            package P
            import System
            import System.IO

            var result = FileAccess.Read & FileAccess.ReadWrite
            Console.WriteLine(int32(result))
            """;

        // FileAccess.Read = 1, FileAccess.ReadWrite = 3 → 1 & 3 = 1
        Assert.Equal("1\n", CompileAndRun(source));
    }

    // ── Positive: CLR enum bitwise XOR ───────────────────────────────

    [Fact]
    public void RegexOptions_BitwiseXor_ProducesCorrectValue()
    {
        var source = """
            package P
            import System
            import System.Text.RegularExpressions

            var result = RegexOptions.IgnoreCase ^ RegexOptions.Multiline
            Console.WriteLine(int32(result))
            """;

        // RegexOptions.IgnoreCase = 1, RegexOptions.Multiline = 2 → 1 ^ 2 = 3
        Assert.Equal("3\n", CompileAndRun(source));
    }

    // ── Positive: CLR enum unary complement ──────────────────────────

    [Fact]
    public void FileShare_UnaryComplement_ProducesCorrectValue()
    {
        var source = """
            package P
            import System
            import System.IO

            var result = ^FileShare.None
            Console.WriteLine(int32(result))
            """;

        // FileShare.None = 0 → ~0 = -1
        Assert.Equal("-1\n", CompileAndRun(source));
    }

    // ── Positive: UnixFileMode (also int32-backed, different enum) ───

    [Fact]
    public void UnixFileMode_BitwiseOr_ProducesCorrectValue()
    {
        var source = """
            package P
            import System
            import System.IO

            var mode = UnixFileMode.UserRead | UnixFileMode.UserWrite
            Console.WriteLine(int32(mode))
            """;

        // UnixFileMode.UserRead = 256, UnixFileMode.UserWrite = 128 → 256 | 128 = 384
        Assert.Equal("384\n", CompileAndRun(source));
    }

    // ── Positive: user-defined C# probe enum with [Flags] : long ────

    [Fact]
    public void LongBackedFlagsEnum_BitwiseOr_ProducesCorrectValue()
    {
        var csSource = """
            using System;

            namespace Probe534
            {
                [Flags]
                public enum LargeFlags : long
                {
                    None = 0,
                    Alpha = 1L,
                    Beta  = 2L,
                    Gamma = 4L,
                    Big   = 1L << 40,
                }
            }
            """;

        var gsSource = """
            package P
            import System
            import Probe534

            var combined = LargeFlags.Alpha | LargeFlags.Big
            Console.WriteLine(int64(combined))
            """;

        // Alpha = 1, Big = 1 << 40 = 1099511627776 → 1 | 1099511627776 = 1099511627777
        Assert.Equal("1099511627777\n", CompileAndRunWithSiblingCs(csSource, gsSource, "Probe534"));
    }

    [Fact]
    public void LongBackedFlagsEnum_BitwiseAnd_ProducesCorrectValue()
    {
        var csSource = """
            using System;

            namespace Probe534
            {
                [Flags]
                public enum LargeFlags : long
                {
                    None = 0,
                    Alpha = 1L,
                    Beta  = 2L,
                    Gamma = 4L,
                    Big   = 1L << 40,
                }
            }
            """;

        var gsSource = """
            package P
            import System
            import Probe534

            var all = LargeFlags.Alpha | LargeFlags.Beta | LargeFlags.Gamma
            var mask = LargeFlags.Alpha | LargeFlags.Gamma
            var result = all & mask
            Console.WriteLine(int64(result))
            """;

        // all = 7, mask = 5 → 7 & 5 = 5
        Assert.Equal("5\n", CompileAndRunWithSiblingCs(csSource, gsSource, "Probe534"));
    }

    [Fact]
    public void LongBackedFlagsEnum_UnaryComplement_ProducesCorrectValue()
    {
        var csSource = """
            using System;

            namespace Probe534
            {
                [Flags]
                public enum LargeFlags : long
                {
                    None = 0,
                    Alpha = 1L,
                    Beta  = 2L,
                    Gamma = 4L,
                    Big   = 1L << 40,
                }
            }
            """;

        var gsSource = """
            package P
            import System
            import Probe534

            var result = ^LargeFlags.None
            Console.WriteLine(int64(result))
            """;

        // ~0L = -1
        Assert.Equal("-1\n", CompileAndRunWithSiblingCs(csSource, gsSource, "Probe534"));
    }

    // ── Positive: byte-backed enum to exercise sub-i4 truncation ─────

    [Fact]
    public void ByteBackedEnum_BitwiseOr_ProducesCorrectValue()
    {
        var csSource = """
            using System;

            namespace Probe534
            {
                [Flags]
                public enum SmallFlags : byte
                {
                    None = 0,
                    A = 1,
                    B = 2,
                    C = 4,
                }
            }
            """;

        var gsSource = """
            package P
            import System
            import Probe534

            var combined = SmallFlags.A | SmallFlags.C
            Console.WriteLine(int32(combined))
            """;

        // A = 1, C = 4 → 1 | 4 = 5
        Assert.Equal("5\n", CompileAndRunWithSiblingCs(csSource, gsSource, "Probe534"));
    }

    // ── Regression: int32 | int32 still works ────────────────────────

    [Fact]
    public void Int32_BitwiseOr_StillWorks()
    {
        var source = """
            package P
            import System

            Console.WriteLine(3 | 4)
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    // ── Regression: bool | bool still works ──────────────────────────

    [Fact]
    public void Bool_BitwiseOr_StillWorks()
    {
        var source = """
            package P
            import System

            let a = true
            let b = false
            Console.WriteLine(a | b)
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    // ── Negative: mixed enum types → diagnostic ──────────────────────

    [Fact]
    public void MixedEnumTypes_BitwiseOr_ProducesDiagnostic()
    {
        var source = """
            package P
            import System
            import System.IO

            var bad = FileShare.Read | FileAccess.Read
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("'|'") && d.Contains("FileShare") && d.Contains("FileAccess"));
    }

    // ── Negative: enum + integer → diagnostic ────────────────────────

    [Fact]
    public void Enum_BitwiseOr_WithInt_ProducesDiagnostic()
    {
        var source = """
            package P
            import System
            import System.IO

            var bad = FileShare.Read | 1
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("'|'") && d.Contains("FileShare"));
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue534_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
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

            using var proc = Process.Start(psi);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue534_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    srcPath,
                });
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue534_sib_").FullName;
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
