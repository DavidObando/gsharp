// <copyright file="Issue664ClrArrayIndexerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit and execution tests for issue #664: CLR <c>T[]</c> arrays
/// (e.g. the result of <c>string.Split</c>) must be indexable with <c>arr[i]</c>
/// for both read and write, emitting correct <c>ldelem</c>/<c>stelem</c> opcodes.
/// </summary>
public class Issue664ClrArrayIndexerEmitTests
{
    [Fact]
    public void StringSplit_IndexZero_ReturnsFirstElement()
    {
        var source = """
            package P
            import System

            let parts = "a,b,c".Split(",")
            Console.WriteLine(parts[0])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a\n", output);
    }

    [Fact]
    public void StringArray_IndexAssignment_Works()
    {
        var source = """
            package P
            import System

            var parts = "a,b,c".Split(",")
            parts[0] = "z"
            Console.WriteLine(parts[0])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("z\n", output);
    }

    [Fact]
    public void IntArray_ReadIndex_Works()
    {
        var source = """
            package P
            import System
            import System.Linq

            var arr = Enumerable.ToArray[int32](Enumerable.Range(10, 3))
            Console.WriteLine(arr[1])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n", output);
    }

    [Fact]
    public void IntArray_WriteIndex_Works()
    {
        var source = """
            package P
            import System
            import System.Linq

            var arr = Enumerable.ToArray[int32](Enumerable.Range(0, 3))
            arr[0] = 99
            Console.WriteLine(arr[0])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void ObjectArray_ReadIndex_Works()
    {
        var source = """
            package P
            import System

            let cmdArgs = Environment.GetCommandLineArgs()
            let first = cmdArgs[0]
            Console.WriteLine(first != "")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void CharArray_ReadIndex_Works()
    {
        var source = """
            package P
            import System

            var ca = "hello".ToCharArray()
            Console.WriteLine(int32(ca[0]))
            Console.WriteLine(int32(ca[4]))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("104\n111\n", output);
    }

    [Fact]
    public void CharArray_WriteIndex_Works()
    {
        var source = """
            package P
            import System

            var ca = "hello".ToCharArray()
            ca[0] = 'H'
            Console.WriteLine(int32(ca[0]))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("72\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue664_").FullName;
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
