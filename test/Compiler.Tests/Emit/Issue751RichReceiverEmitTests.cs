// <copyright file="Issue751RichReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit + run coverage for issue #751 / ADR-0084 §L2: the
/// receiver clause now accepts rich type spellings (nullable, generic
/// application, tuple, nullable array, map[K,V]). Each test compiles a
/// G# program containing an extension method declaration whose receiver
/// previously rejected at parse time, IL-verifies the output, and
/// executes it under <c>dotnet exec</c> to prove the dispatched call
/// reaches the extension body.
/// </summary>
public class Issue751RichReceiverEmitTests
{
    [Fact]
    public void NullableString_Receiver_RoundTrips()
    {
        var source = """
            package P
            import System

            func (self string?) OrElse(fb string) string {
                return self ?? fb
            }

            var present string? = "hi"
            var absent string? = nil
            Console.WriteLine(present.OrElse("nope"))
            Console.WriteLine(absent.OrElse("nope"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\nnope\n", output);
    }

    [Fact]
    public void Tuple_Receiver_RoundTrips()
    {
        var source = """
            package P
            import System

            func (self (int32, string)) Show() string {
                return self.Item1.ToString() + ":" + self.Item2
            }

            var p = (42, "hi")
            Console.WriteLine(p.Show())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42:hi\n", output);
    }

    [Fact]
    public void NullableArray_Receiver_RoundTrips()
    {
        var source = """
            package P
            import System

            func (self []int32?) FirstOrZero() int32 {
                if self == nil {
                    return 0
                }
                if self.Length == 0 {
                    return 0
                }
                return self[0]
            }

            var present []int32? = []int32{10, 20}
            var absent []int32? = nil
            Console.WriteLine(present.FirstOrZero())
            Console.WriteLine(absent.FirstOrZero())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n0\n", output);
    }

    [Fact]
    public void Map_Receiver_RoundTrips()
    {
        var source = """
            package P
            import System

            func (self map[string,int32]) CountKeys() int32 {
                return self.Count
            }

            var m = map[string,int32]{"a": 1, "b": 2, "c": 3}
            Console.WriteLine(m.CountKeys())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue751_").FullName;
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
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            if (!File.Exists(runtimeConfigPath))
            {
                File.WriteAllText(runtimeConfigPath, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(runtimeConfigPath);
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // best effort
            }
        }
    }
}
