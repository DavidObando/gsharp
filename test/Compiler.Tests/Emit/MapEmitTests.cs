// <copyright file="MapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Emit coverage for map.
/// </summary>
public class MapEmitTests
{
    [Fact]
    public void MapLiteral_AndIndexRead()
    {
        var source = """
            package P
            import System

            var m = map[string,int32]{"a": 1, "b": 2}
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"1{Environment.NewLine}2{Environment.NewLine}", output);
    }

    [Fact]
    public void MapIndex_MissingKey_ReturnsZeroValue()
    {
        var source = """
            package P
            import System

            var m = map[string,int32]{"a": 1}
            Console.WriteLine(m["missing"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"0{Environment.NewLine}", output);
    }

    [Fact]
    public void MapIndexAssignment_AddAndUpdate()
    {
        var source = """
            package P
            import System

            var m = map[string,int32]{}
            m["a"] = 1
            m["b"] = 2
            m["a"] = 99
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"99{Environment.NewLine}2{Environment.NewLine}", output);
    }

    [Fact]
    public void Len_OnMap_ReturnsCount()
    {
        var source = """
            package P
            import System
            import Gsharp.Extensions.Go

            var m = map[string,int32]{"a": 1, "b": 2, "c": 3}
            Console.WriteLine(len(m))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"3{Environment.NewLine}", output);
    }

    [Fact]
    public void Delete_RemovesKey_AndDecreasesLen()
    {
        var source = """
            package P
            import System
            import Gsharp.Extensions.Go

            var m = map[string,int32]{"a": 1, "b": 2}
            delete(m, "a")
            Console.WriteLine(len(m))
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"1{Environment.NewLine}0{Environment.NewLine}2{Environment.NewLine}", output);
    }

    [Fact]
    public void EmptyMapLiteral_LenIsZero()
    {
        var source = """
            package P
            import System
            import Gsharp.Extensions.Go

            var m = map[int32,string]{}
            Console.WriteLine(len(m))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"0{Environment.NewLine}", output);
    }

    [Fact]
    public void Map_IntKey_StringValue_RoundTrip()
    {
        var source = """
            package P
            import System

            var m = map[int32,string]{1: "one", 2: "two"}
            Console.WriteLine(m[1])
            Console.WriteLine(m[2])
            Console.WriteLine(m[42])
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"one{Environment.NewLine}two{Environment.NewLine}{Environment.NewLine}", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_map_emit_").FullName;
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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
