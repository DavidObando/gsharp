// <copyright file="Issue833OpenTGenericMethodCallReturnTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #833 end-to-end coverage. The binder + emitter fix re-projects
/// open method type parameters (MVar) through the return type of
/// imported generic-method calls (e.g. <c>Enumerable.Empty[T]()</c>,
/// <c>Array.Empty[T]()</c>, <c>[]T{}.ToArray()</c>). These tests
/// round-trip each scenario through compile → IL-verify → run so we
/// catch any emit-time regression in the MethodSpec encoding (ADR-0087
/// F1 / parent #706).
/// </summary>
public class Issue833OpenTGenericMethodCallReturnTypeEmitTests
{
    [Fact]
    public void EnumerableEmpty_With_OpenT_Roundtrips_Int32()
    {
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Empty[T]() IEnumerable[T] {
                        return Enumerable.Empty[T]()
                    }
                }
            }

            var seq = Sequences.Empty[int32]()
            var count = 0
            for v in seq {
                count = count + 1
            }
            Console.WriteLine(count)
            Console.WriteLine("done")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\ndone\n", output);
    }

    [Fact]
    public void EnumerableEmpty_With_OpenT_Roundtrips_String()
    {
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            func Empty[T]() IEnumerable[T] {
                return Enumerable.Empty[T]()
            }

            var seq = Empty[string]()
            var count = 0
            for v in seq {
                count = count + 1
            }
            Console.WriteLine(count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void ArrayEmpty_With_OpenT_Returns_SliceOfT_Roundtrips_Int32()
    {
        var source = """
            package P
            import System

            class Sequences {
                shared {
                    func Empty[T]() []T {
                        return Array.Empty[T]()
                    }
                }
            }

            var arr = Sequences.Empty[int32]()
            Console.WriteLine(arr.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void ToArray_On_OpenT_Slice_Returns_SliceOfT_Roundtrips()
    {
        var source = """
            package P
            import System
            import System.Linq

            func MakeEmpty[T]() []T {
                return []T{}.ToArray()
            }

            var arr = MakeEmpty[int32]()
            Console.WriteLine(arr.Length)
            var arrS = MakeEmpty[string]()
            Console.WriteLine(arrS.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n0\n", output);
    }

    [Fact]
    public void EnumerableRepeat_With_OpenT_Roundtrips_Value()
    {
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            func Repeat[T](v T, n int32) IEnumerable[T] {
                return Enumerable.Repeat[T](v, n)
            }

            var seq = Repeat[int32](42, 3)
            for v in seq {
                Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n42\n42\n", output);
    }

    [Fact]
    public void EnumerableEmpty_Inside_Generic_Extension_Method_Roundtrips()
    {
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            func (self []T) ReplaceWithEmpty[T]() IEnumerable[T] {
                return Enumerable.Empty[T]()
            }

            var arr = []int32{1, 2, 3}
            var seq = arr.ReplaceWithEmpty()
            var count = 0
            for v in seq {
                count = count + 1
            }
            Console.WriteLine(count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue833_emit_").FullName;
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
