// <copyright file="ForRangeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 4 emit-parity tests for `for k, v := range coll` across the three
/// iteration shapes the binder produces: Indexed (arrays), Dictionary
/// (Dictionary[K,V]), and Enumerable (List[T] and other IEnumerable[T]).
/// All three are lowered by <c>Lowerer.LowerCollectionRange</c> /
/// <c>LowerIndexedRange</c> and rely on the CLR-interop emit paths added in
/// commit A plus value-type-receiver handling for struct enumerators.
/// </summary>
public class ForRangeEmitTests
{
    [Fact]
    public void IndexedRange_OverFixedArray()
    {
        var source = """
            package P
            import System

            var arr = [3]int{100, 200, 300}
            for i, v := range arr {
              Console.WriteLine(i)
              Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n100\n1\n200\n2\n300\n", output);
    }

    [Fact]
    public void EnumerableRange_OverList_ValueOnly()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var xs = List[int]()
            xs.Add(10)
            xs.Add(20)
            xs.Add(30)
            for v := range xs {
              Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n20\n30\n", output);
    }

    [Fact]
    public void EnumerableRange_OverList_WithIndex()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var xs = List[int]()
            xs.Add(10)
            xs.Add(20)
            for i, v := range xs {
              Console.WriteLine(i)
              Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n10\n1\n20\n", output);
    }

    [Fact]
    public void DictionaryRange_KeysAndValues()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var d = Dictionary[string, int]()
            d["a"] = 1
            d["b"] = 2
            for k, v := range d {
              Console.WriteLine(k)
              Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a\n1\nb\n2\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_for_range_emit_").FullName;
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
