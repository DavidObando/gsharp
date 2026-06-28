// <copyright file="Issue6_6EnumArithmeticEmitTests.cs" company="GSharp">
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
/// Bug-overview item 6.6: C# §11.10 enum arithmetic operators.
/// Tests the four §11.10 arithmetic rules:
///   enum + underlying → enum
///   underlying + enum → enum
///   enum - underlying → enum
///   enum - enum → underlying
/// Coverage includes both imported CLR enums and user-defined G# enums,
/// and both signed-backed (int32) and unsigned-backed (byte) enums.
/// </summary>
public class Issue6_6EnumArithmeticEmitTests
{
    [Fact]
    public void DayOfWeek_Plus_Int32_Produces_Enum()
    {
        var source = """
            package P
            import System

            Console.WriteLine(DayOfWeek.Monday + int32(2))
            """;

        Assert.Equal("Wednesday\n", CompileAndRun(source));
    }

    [Fact]
    public void Int32_Plus_DayOfWeek_Produces_Enum()
    {
        var source = """
            package P
            import System

            Console.WriteLine(int32(2) + DayOfWeek.Monday)
            """;

        Assert.Equal("Wednesday\n", CompileAndRun(source));
    }

    [Fact]
    public void DayOfWeek_Minus_Int32_Produces_Enum()
    {
        var source = """
            package P
            import System

            Console.WriteLine(DayOfWeek.Friday - int32(1))
            """;

        Assert.Equal("Thursday\n", CompileAndRun(source));
    }

    [Fact]
    public void DayOfWeek_Minus_DayOfWeek_Produces_Underlying()
    {
        var source = """
            package P
            import System

            Console.WriteLine(DayOfWeek.Friday - DayOfWeek.Monday)
            """;

        Assert.Equal("4\n", CompileAndRun(source));
    }

    [Fact]
    public void UserDefinedEnum_Plus_Int32()
    {
        var source = """
            package P
            import System

            enum Color {
                Red,
                Green,
                Blue,
            }

            var c = Color.Red + int32(2)
            Console.WriteLine(c == Color.Blue)
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void UserDefinedEnum_Minus_UserDefinedEnum()
    {
        var source = """
            package P
            import System

            enum Color {
                Red,
                Green,
                Blue,
            }

            Console.WriteLine(Color.Blue - Color.Red)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Int32_Plus_UserDefinedEnum()
    {
        var source = """
            package P
            import System

            enum Color {
                Red,
                Green,
                Blue,
            }

            var c = int32(1) + Color.Red
            Console.WriteLine(c == Color.Green)
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void UnsignedBackedEnum_Plus_Underlying()
    {
        var csSource = """
            namespace TestEnums
            {
                public enum ByteEnum : byte
                {
                    Zero = 0,
                    One = 1,
                    Two = 2,
                    Three = 3,
                }
            }
            """;
        var gSource = """
            package P
            import System
            import TestEnums

            var v = ByteEnum.One + uint8(2)
            Console.WriteLine(v == ByteEnum.Three)
            """;

        Assert.Equal("True\n", CompileAndRunWithSiblingCs(csSource, gSource, "TestEnums"));
    }

    [Fact]
    public void UnsignedBackedEnum_Minus_Enum()
    {
        var csSource = """
            namespace TestEnums
            {
                public enum ByteEnum : byte
                {
                    Zero = 0,
                    One = 1,
                    Two = 2,
                    Three = 3,
                }
            }
            """;
        var gSource = """
            package P
            import System
            import TestEnums

            Console.WriteLine(ByteEnum.Three - ByteEnum.One)
            """;

        Assert.Equal("2\n", CompileAndRunWithSiblingCs(csSource, gSource, "TestEnums"));
    }

    [Fact]
    public void Negative_EnumTimesEnum_ProducesDiagnostic()
    {
        var source = """
            package P
            import System

            var bad = DayOfWeek.Monday * DayOfWeek.Tuesday
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("'*'") && d.Contains("DayOfWeek"));
    }

    [Fact]
    public void Negative_EnumShiftLeft_ProducesDiagnostic()
    {
        var source = """
            package P
            import System

            var bad = DayOfWeek.Monday << int32(1)
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("'<<'"));
    }

    // ── Helpers ────────────────────────────────────────────────────────

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue6_6_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue6_6_neg_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue6_6_sib_").FullName;
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
