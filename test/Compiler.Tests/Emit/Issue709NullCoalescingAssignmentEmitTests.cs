// <copyright file="Issue709NullCoalescingAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #709 / ADR-0072 — emit coverage for the new <c>??=</c>
/// null-coalescing compound assignment statement. Each test compiles via
/// in-process <c>gsc</c>, IL-verifies the emitted PE, and runs it under
/// <c>dotnet exec</c>, asserting captured stdout.
/// </summary>
public class Issue709NullCoalescingAssignmentEmitTests
{
    [Fact]
    public void Local_NullableString_WritesWhenNil_PreservesWhenNonNil()
    {
        var source = """
            package Test
            import System

            func main() {
                var x string? = nil
                x ??= "first"
                Console.WriteLine(x)
                x ??= "second"
                Console.WriteLine(x)
            }

            main()
            """;

        Assert.Equal("first\nfirst\n", CompileAndRun(source));
    }

    [Fact]
    public void Local_NullableInt32_WritesWhenNil_PreservesWhenNonNil()
    {
        var source = """
            package Test
            import System

            func main() {
                var n int32? = nil
                n ??= 42
                Console.WriteLine(n)
                n ??= 99
                Console.WriteLine(n)
            }

            main()
            """;

        Assert.Equal("42\n42\n", CompileAndRun(source));
    }

    [Fact]
    public void Field_LHS_WritesThroughClassReceiver()
    {
        var source = """
            package Test
            import System

            class Box {
                var Name string?
            }

            func main() {
                var b = Box{Name: nil}
                b.Name ??= "set"
                Console.WriteLine(b.Name)
                b.Name ??= "ignored"
                Console.WriteLine(b.Name)
            }

            main()
            """;

        Assert.Equal("set\nset\n", CompileAndRun(source));
    }

    [Fact]
    public void Property_LHS_WritesThroughAutoProperty()
    {
        var source = """
            package Test
            import System

            class Person {
                prop Name string?
            }

            func main() {
                var p = Person{}
                p.Name ??= "Alice"
                Console.WriteLine(p.Name)
                p.Name ??= "Bob"
                Console.WriteLine(p.Name)
            }

            main()
            """;

        Assert.Equal("Alice\nAlice\n", CompileAndRun(source));
    }

    [Fact]
    public void Map_IndexerLHS_WritesWhenNil()
    {
        var source = """
            package Test
            import System

            func main() {
                var m = map[string,string?]{}
                m["k"] = nil
                m["k"] ??= "v"
                Console.WriteLine(m["k"])
                m["k"] ??= "ignored"
                Console.WriteLine(m["k"])
            }

            main()
            """;

        Assert.Equal("v\nv\n", CompileAndRun(source));
    }

    [Fact]
    public void Receiver_EvaluatedOnce_RhsOnlyWhenNil()
    {
        // The receiver function is called once per `??=` regardless of
        // whether the write fires. The RHS function is called only when
        // the current value is nil — single-evaluation guarantee.
        var source = """
            package Test
            import System

            class Box {
                var Name string?
            }

            var receiverCalls int32 = 0
            var rhsCalls int32 = 0

            func getBox(b Box) Box {
                receiverCalls = receiverCalls + 1
                return b
            }

            func computeRhs() string {
                rhsCalls = rhsCalls + 1
                return "v"
            }

            func main() {
                var b = Box{Name: nil}

                getBox(b).Name ??= computeRhs()
                Console.WriteLine(receiverCalls)
                Console.WriteLine(rhsCalls)
                Console.WriteLine(b.Name)

                getBox(b).Name ??= computeRhs()
                Console.WriteLine(receiverCalls)
                Console.WriteLine(rhsCalls)
                Console.WriteLine(b.Name)
            }

            main()
            """;

        // First call: receiver=1, rhs=1 (Name was nil), b.Name=v.
        // Second call: receiver=2 (called again), rhs still 1 (b.Name is
        // no longer nil so RHS is short-circuited), b.Name still v.
        Assert.Equal("1\n1\nv\n2\n1\nv\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue709_").FullName;
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
