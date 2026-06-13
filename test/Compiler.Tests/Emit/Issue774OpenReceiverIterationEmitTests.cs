// <copyright file="Issue774OpenReceiverIterationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #774 follow-up: end-to-end emit + IL-verify coverage for
/// iterating an open-generic receiver via <c>for v in self</c>. Pre-fix
/// the binder rejected these programs with <c>GS0155</c>; this suite
/// validates that the produced assembly is IL-verifiable and runs to
/// the expected stdout.
/// </summary>
public class Issue774OpenReceiverIterationEmitTests
{
    [Fact]
    public void IEnumerableT_Receiver_ForIn_Returns_First_Element_As_T()
    {
        // Issue repro shape: iterate the open receiver, return the
        // first element typed as T. Pre-fix this failed to bind.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (self IEnumerable[T]) MyFirst[T any](fb T) T {
                for v in self {
                    return v
                }
                return fb
            }

            var arr = []int32{10, 20, 30}
            Console.WriteLine(arr.MyFirst(0))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n", output);
    }

    [Fact]
    public void IEnumerableT_Receiver_ForIn_Counts_Elements()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (self IEnumerable[T]) MyCount[T](seed T) int32 {
                var n = 0
                for v in self {
                    n = n + 1
                }
                return n
            }

            var arr = []string{"a", "b", "c", "d"}
            Console.WriteLine(arr.MyCount(""))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n", output);
    }

    [Fact]
    public void SequenceT_Receiver_ForIn_Forwards_Element_As_T()
    {
        var source = """
            package P
            import System

            func passthrough[T](x T) T {
                return x
            }

            func (self sequence[T]) FirstOr[T](fb T) T {
                for v in self {
                    return passthrough(v)
                }
                return fb
            }

            var arr = []int32{42, 99}
            Console.WriteLine(arr.FirstOr(0))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void SliceT_Receiver_ForIn_Returns_First_Element()
    {
        var source = """
            package P
            import System

            func (self []T) Head[T](fb T) T {
                for v in self {
                    return v
                }
                return fb
            }

            var arr = []int32{7, 8, 9}
            Console.WriteLine(arr.Head(0))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void IEnumerableT_Receiver_ForIn_Roundtrips_StringElement()
    {
        // Body returns the iteration variable as T to a string callsite.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (self IEnumerable[T]) MyFirst[T](fb T) T {
                for v in self {
                    return v
                }
                return fb
            }

            var arr = []string{"hello", "world"}
            Console.WriteLine(arr.MyFirst(""))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void DictionaryKV_Receiver_ForIn_Returns_First_Key_And_Value()
    {
        // `for k, v in self` over `Dictionary[K, V]` must surface k as
        // K and v as V. Pre-fix the binder erased both to object;
        // post-fix the emit path lowers them through the KeyValuePair
        // pair-projection and IL-verifies clean.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (self Dictionary[K, V]) FirstValueOr[K, V](fb V) V {
                for k, v in self {
                    return v
                }
                return fb
            }

            var d = Dictionary[string, int32]()
            d["a"] = 100
            Console.WriteLine(d.FirstValueOr(0))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("100\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue774_emit_").FullName;
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
