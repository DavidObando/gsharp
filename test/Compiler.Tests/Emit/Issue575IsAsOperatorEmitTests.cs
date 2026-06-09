// <copyright file="Issue575IsAsOperatorEmitTests.cs" company="GSharp">
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
/// Issue #575: expression-level <c>is</c> (type-test) and <c>as</c> (safe-cast) operators.
/// Each test compiles via in-process <c>gsc</c>, IL-verifies the PE, then runs
/// under <c>dotnet exec</c> and asserts captured stdout.
/// </summary>
public class Issue575IsAsOperatorEmitTests
{
    [Fact]
    public void Is_RefType_ReturnsTrue_WhenMatch()
    {
        var source = """
            package Test
            import System
            import System.Text.Json.Nodes

            let node JsonNode = JsonArray()
            let result = node is JsonArray
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void Is_RefType_ReturnsFalse_WhenMismatch()
    {
        var source = """
            package Test
            import System
            import System.Text.Json.Nodes

            let node JsonNode = JsonValue.Create(42)
            let result = node is JsonArray
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n", output);
    }

    [Fact]
    public void Is_ValueType_ReturnsTrue_WhenMatch()
    {
        var source = """
            package Test
            import System

            let boxed object = 5
            let result = boxed is Int32
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void Is_OnNull_ReturnsFalse()
    {
        var source = """
            package Test
            import System

            let x String? = nil
            let result = x is String
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n", output);
    }

    [Fact]
    public void As_RefType_ReturnsInstance_WhenMatch()
    {
        var source = """
            package Test
            import System
            import System.Text.Json.Nodes

            let node JsonNode = JsonArray()
            let arr = node as JsonArray
            let check = arr is JsonArray
            Console.WriteLine(check)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void As_RefType_ReturnsNull_WhenMismatch()
    {
        var source = """
            package Test
            import System
            import System.Text.Json.Nodes

            let node JsonNode = JsonValue.Create(42)
            let arr = node as JsonArray
            let check = arr is JsonArray
            Console.WriteLine(check)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n", output);
    }

    [Fact]
    public void As_OnNull_ReturnsNull()
    {
        var source = """
            package Test
            import System

            let x String? = nil
            let s = x as String
            Console.WriteLine(s == nil)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void As_ValueType_RequiresNullable_DefaultMatchesCSharp()
    {
        var source = """
            package Test
            import System

            let boxed object = 42
            let result = boxed as Int32?
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Is_PrecedenceVsEquality()
    {
        // (x is T) == true should parse as: ((x is T) == true)
        var source = """
            package Test
            import System

            let x object = "hello"
            let result = (x is String) == true
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void Is_PrecedenceVsLogical()
    {
        // a is T && b is U should parse as: (a is T) && (b is U)
        var source = """
            package Test
            import System

            let a object = "hello"
            let b object = 42
            let result = a is String && b is Int32
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void As_OnNonNullableValueType_ErrorsWithPreciseGS()
    {
        var source = """
            package Test
            import System

            let boxed object = 42
            let result = boxed as Int32
            Console.WriteLine(result)
            """;

        var (exitCode, stdout, _) = CompileAndRunRaw(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0270", stdout);
    }

    [Fact]
    public void PatternLevel_Is_InSwitch_StillWorks()
    {
        // Regression: the existing pattern-level `identifier is Type` syntax
        // in switch arms must continue to parse and compile correctly.
        var source = """
            package Test
            import System

            let x object = "hello"
            switch x {
                case s is String {
                    Console.WriteLine(s)
                }
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void PatternLevel_Is_InSwitch_ValueType_StillWorks()
    {
        var source = """
            package Test
            import System

            let x object = 99
            switch x {
                case n is Int32 {
                    Console.WriteLine(n)
                }
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"gsc failed (exit {exitCode}):\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue575_").FullName;
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
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add("/nowarn:GS9100");
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

            if (compileExit != 0)
            {
                return (compileExit, compileOut.ToString(), compileErr.ToString());
            }

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

            if (proc.ExitCode != 0)
            {
                return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
            }

            return (0, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
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
