// <copyright file="Issue618IndexCaptureRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #618 regression guard: verifies that closures capturing a variable
/// used only as the target of an index-assignment expression (array element
/// write, map key write, or CLR indexer write) compile correctly. Before
/// #618 the raw <c>VariableSymbol</c> target was invisible to both
/// <c>CapturedVariableCollector</c> and <c>BoxingRewriter</c>, causing
/// either a missing closure field (capture analysis gap) or a stale slot
/// reference (boxing rewrite gap).
/// </summary>
public class Issue618IndexCaptureRegressionTests
{
    /// <summary>
    /// Lambda captures a local array and writes an element via index
    /// assignment. The outer scope observes the mutation.
    /// </summary>
    [Fact]
    public void ArrayIndexWrite_FromClosure()
    {
        var source = """
            package Probe
            import System

            func Run() int32 {
                var arr = []int32{0, 0, 0}
                var writer = func(i int32, v int32) { arr[i] = v }
                writer(1, 42)
                return arr[1]
            }

            Console.WriteLine(Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    /// <summary>
    /// Lambda captures a local map and writes a key via index assignment.
    /// The outer scope observes the mutation.
    /// </summary>
    [Fact]
    public void MapIndexWrite_FromClosure()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func Run() int32 {
                var m = map[string,int32]{}
                var put = func(k string, v int32) { m[k] = v }
                put("hello", 7)
                return m["hello"]
            }

            Console.WriteLine(Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    /// <summary>
    /// Lambda captures a local Dictionary and writes a key via CLR indexer
    /// assignment. The outer scope observes the mutation.
    /// </summary>
    [Fact]
    public void ClrIndexerWrite_FromClosure()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func Run() int32 {
                var d = Dictionary[string, int32]()
                var put = func(k string, v int32) { d[k] = v }
                put("x", 99)
                return d["x"]
            }

            Console.WriteLine(Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    /// <summary>
    /// Lambda captures a local array inside a class method and writes
    /// an element. Confirms the fix works in the class-method path too.
    /// </summary>
    [Fact]
    public void ArrayIndexWrite_FromClosureInClassMethod()
    {
        var source = """
            package Probe
            import System

            class Probe {
                init() {}
                func Run() int32 {
                    var arr = []int32{10, 20, 30}
                    var writer = func(v int32) { arr[0] = v }
                    writer(55)
                    return arr[0]
                }
            }

            var p = Probe()
            Console.WriteLine(p.Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("55\n", output);
    }

    /// <summary>
    /// Two lambdas share the same captured map and observe each other's
    /// writes through the shared box.
    /// </summary>
    [Fact]
    public void MultipleClosures_ShareCapturedMap()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func Run() int32 {
                var m = map[string,int32]{}
                var put = func(k string, v int32) { m[k] = v }
                var get = func(k string) int32 { return m[k] }
                put("a", 1)
                put("b", 2)
                return get("a") + get("b")
            }

            Console.WriteLine(Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_618_").FullName;
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

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
