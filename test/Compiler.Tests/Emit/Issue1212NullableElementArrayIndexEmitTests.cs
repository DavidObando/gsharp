// <copyright file="Issue1212NullableElementArrayIndexEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1212 — emit/execution coverage for indexing an array/slice whose
/// element type is nullable (<c>[]T?</c>). Each test compiles via in-process
/// <c>gsc</c>, IL-verifies the emitted PE, and runs it under <c>dotnet exec</c>,
/// asserting captured stdout. Both a nullable *value*-element array
/// (<c>[]int32?</c>, backed by <c>Nullable&lt;int32&gt;[]</c>) and a nullable
/// *reference*-element array (<c>[]object?</c>, backed by <c>object[]</c>) are
/// written (including a nil and a value) and read back, proving the emitted
/// <c>ldelem</c>/<c>stelem</c> round-trip the nullable element correctly.
/// </summary>
public class Issue1212NullableElementArrayIndexEmitTests
{
    [Fact]
    public void NullableValueElementSlice_WriteReadRoundTrips()
    {
        var source = """
            package Test
            import System

            func main() {
                var a []int32? = []int32?{nil, 7, nil}
                a[0] = 42
                if a[0] == nil { Console.WriteLine("nil") } else { Console.WriteLine(a[0]!!) }
                if a[1] == nil { Console.WriteLine("nil") } else { Console.WriteLine(a[1]!!) }
                if a[2] == nil { Console.WriteLine("nil") } else { Console.WriteLine(a[2]!!) }
            }

            main()
            """;

        Assert.Equal("42\n7\nnil\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableReferenceElementSlice_WriteReadRoundTrips()
    {
        var source = """
            package Test
            import System

            func main() {
                var a []object? = []object?{nil, "hi"}
                a[0] = "set"
                if a[0] == nil { Console.WriteLine("nil") } else { Console.WriteLine(a[0]!!) }
                if a[1] == nil { Console.WriteLine("nil") } else { Console.WriteLine(a[1]!!) }
            }

            main()
            """;

        Assert.Equal("set\nhi\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableValueElementSlice_WriteNil_ReadsBackNil()
    {
        var source = """
            package Test
            import System

            func main() {
                var a []int32? = []int32?{1, 2, 3}
                a[1] = nil
                Console.WriteLine(a.Length)
                if a[1] == nil {
                    Console.WriteLine("cleared")
                } else {
                    Console.WriteLine("kept")
                }
                Console.WriteLine(a[2]!!)
            }

            main()
            """;

        Assert.Equal("3\ncleared\n3\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1212_").FullName;
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
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
