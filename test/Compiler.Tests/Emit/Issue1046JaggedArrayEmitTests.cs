// <copyright file="Issue1046JaggedArrayEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit tests for issue #1046 — jagged/nested array types. The
/// array/slice element is now a full nested type clause, so <c>[][]T</c>
/// (jagged), <c>[]*T</c> and <c>[]map[K]V</c> parse, bind and emit. These tests
/// build a runnable program, ilverify it, execute it and assert the runtime
/// output. The motivating case is C# <c>byte[][]</c> → G# <c>[][]uint8</c>.
/// <para>
/// Note: depth is exercised here with double-nested array literals. Triple+
/// nested array <em>literals</em> can exceed the historical fixed method
/// <c>maxstack</c> of 8 — a pre-existing engine limitation that affects any
/// deeply nested expression (e.g. <c>add(1, add(2, add(3, …)))</c>), not just
/// arrays — so it is intentionally out of scope here. Triple-nested array
/// <em>type clauses</em> (e.g. <c>[][][]int32</c> declarations) work fine.
/// </para>
/// </summary>
public class Issue1046JaggedArrayEmitTests
{
    [Fact]
    public void JaggedSliceLiteral_AllocatesReadsElements_PrintsValues()
    {
        // The core issue scenario: declare a jagged slice, build it from inner
        // slice literals, read its length and individual elements.
        var source = """
            package Test
            import System
            var jagged [][]int32 = [][]int32{ []int32{1, 2}, []int32{3, 4, 5} }
            Console.WriteLine(jagged.Length)
            Console.WriteLine(jagged[0][1])
            Console.WriteLine(jagged[1][2])
            """;

        Assert.Equal("2\n2\n5\n", CompileAndRun(source));
    }

    [Fact]
    public void JaggedByteArray_TheMotivatingCsharpCase_RoundTrips()
    {
        // C# `byte[][]` maps to G# `[][]uint8` (DashChunkReader.cs migration).
        var source = """
            package Test
            import System
            var rows [][]uint8 = [][]uint8{ []uint8{uint8(10), uint8(20)}, []uint8{uint8(30)} }
            Console.WriteLine(rows.Length)
            Console.WriteLine(rows[0][1])
            Console.WriteLine(rows[1][0])
            """;

        Assert.Equal("2\n20\n30\n", CompileAndRun(source));
    }

    [Fact]
    public void JaggedSlice_AssignedThroughParameterAndReturn_RoundTrips()
    {
        // Jagged types flow through parameter and return positions.
        var source = """
            package Test
            import System
            func first(grid [][]int32) []int32 { return grid[0] }
            var grid [][]int32 = [][]int32{ []int32{7, 8}, []int32{9} }
            var row []int32 = first(grid)
            Console.WriteLine(row[1])
            """;

        Assert.Equal("8\n", CompileAndRun(source));
    }

    [Fact]
    public void JaggedSlice_IsPattern_SmartCast_Runs()
    {
        // `o is [][]uint8` smart-cast parses, binds and evaluates at runtime.
        var source = """
            package Test
            import System
            func check(o object) bool {
                return o is [][]uint8
            }
            var rows [][]uint8 = [][]uint8{ []uint8{uint8(1)}, []uint8{uint8(2)} }
            Console.WriteLine(check(rows))
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1046_run_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var (compileExit, compileText) = RunCompiler(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileText}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    private static (int Exit, string Output) RunCompiler(string[] args)
    {
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

        return (compileExit, compileOut.ToString() + compileErr.ToString());
    }

    private static void TryDeleteDirectory(string dir)
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch
        {
        }
    }
}
