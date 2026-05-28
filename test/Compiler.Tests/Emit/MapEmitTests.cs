// <copyright file="MapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 3.A.4 emit-parity tests for <c>map[K]V</c>. The backing CLR type is
/// <c>System.Collections.Generic.Dictionary&lt;K, V&gt;</c>:
/// <list type="bullet">
/// <item><description>Map literal <c>map[K]V{k: v, ...}</c> →
/// <c>newobj Dictionary&lt;K,V&gt;..ctor()</c> + <c>callvirt set_Item</c> per entry.</description></item>
/// <item><description>Indexing read <c>m[k]</c> →
/// <c>callvirt TryGetValue(k, out tmp)</c>; pop bool; load tmp — yields the
/// Go zero value when the key is missing, matching the interpreter.</description></item>
/// <item><description>Indexed assignment <c>m[k] = v</c> →
/// <c>callvirt set_Item(k, v)</c>.</description></item>
/// <item><description><c>len(m)</c> → <c>callvirt get_Count</c>.</description></item>
/// <item><description><c>delete(m, k)</c> → <c>callvirt Remove(k)</c>; pop bool.</description></item>
/// </list>
/// </summary>
public class MapEmitTests
{
    [Fact]
    public void MapLiteral_AndIndexRead()
    {
        var source = """
            package P
            import System

            var m = map[string]int32{"a": 1, "b": 2}
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n2\n", output);
    }

    [Fact]
    public void MapIndex_MissingKey_ReturnsZeroValue()
    {
        var source = """
            package P
            import System

            var m = map[string]int32{"a": 1}
            Console.WriteLine(m["missing"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void MapIndexAssignment_AddAndUpdate()
    {
        var source = """
            package P
            import System

            var m = map[string]int32{}
            m["a"] = 1
            m["b"] = 2
            m["a"] = 99
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n2\n", output);
    }

    [Fact]
    public void Len_OnMap_ReturnsCount()
    {
        var source = """
            package P
            import System

            var m = map[string]int32{"a": 1, "b": 2, "c": 3}
            Console.WriteLine(len(m))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void Delete_RemovesKey_AndDecreasesLen()
    {
        var source = """
            package P
            import System

            var m = map[string]int32{"a": 1, "b": 2}
            delete(m, "a")
            Console.WriteLine(len(m))
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n0\n2\n", output);
    }

    [Fact]
    public void EmptyMapLiteral_LenIsZero()
    {
        var source = """
            package P
            import System

            var m = map[int32]string{}
            Console.WriteLine(len(m))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void Map_IntKey_StringValue_RoundTrip()
    {
        var source = """
            package P
            import System

            var m = map[int32]string{1: "one", 2: "two"}
            Console.WriteLine(m[1])
            Console.WriteLine(m[2])
            Console.WriteLine(m[42])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("one\ntwo\n\n", output);
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
}
