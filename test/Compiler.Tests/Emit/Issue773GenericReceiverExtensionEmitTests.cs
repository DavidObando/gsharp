// <copyright file="Issue773GenericReceiverExtensionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #773 / ADR-0084 §L2 follow-up. End-to-end emit + IL-verify
/// coverage for user-defined extension methods whose receiver type
/// carries a function-level type parameter. The pre-fix binder reported
/// GS0159 "Cannot find function" for every call site below; after the
/// fix the binder finds the candidate via receiver unification, the
/// emitter lowers the call through the existing type-erased generic
/// path, and `ilverify` accepts the produced IL.
/// </summary>
public class Issue773GenericReceiverExtensionEmitTests
{
    [Fact]
    public void IEnumerableT_Extension_Dispatches_Int32Slice_Repro()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (self IEnumerable[T]) MyFirst[T any](fb T) T {
                return fb
            }

            var arr = []int32{10, 20, 30}
            Console.WriteLine(arr.MyFirst(99))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void SequenceT_HeadOr_Dispatches_Int32Slice()
    {
        var source = """
            package P
            import System

            func (self sequence[T]) HeadOr[T](fb T) T {
                return fb
            }

            var arr = []int32{1, 2, 3}
            Console.WriteLine(arr.HeadOr(7))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void SequenceT_HeadOr_Dispatches_StringSlice()
    {
        var source = """
            package P
            import System

            func (self sequence[T]) HeadOr[T](fb T) T {
                return fb
            }

            var arr = []string{"a", "b"}
            Console.WriteLine(arr.HeadOr("z"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("z\n", output);
    }

    [Fact]
    public void NullableReceiver_Extension_Dispatches_OnStringNullable_NoBodyNullCheck()
    {
        // The dispatch path (binder + emit) works for `(self T?)` over
        // a reference-typed nullable. The body intentionally avoids
        // comparing an open `T` against `nil` — that pattern stays in
        // the interpreter-side binder tests; the emit gap for it is
        // tracked as a follow-up to this issue.
        var source = """
            package P
            import System

            func (self T?) AlwaysFallback[T](fb T) T {
                return fb
            }

            var s string? = nil
            Console.WriteLine(s.AlwaysFallback("def"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("def\n", output);
    }

    [Fact]
    public void DictionaryReceiver_TwoTypeParameters_Dispatches()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (self Dictionary[K, V]) MyCount[K, V]() int32 {
                return 42
            }

            var d = Dictionary[string, int32]()
            Console.WriteLine(d.MyCount())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void SliceT_Extension_Dispatches_OnInt32Slice()
    {
        var source = """
            package P
            import System

            func (self []T) FirstOr[T](fb T) T {
                return fb
            }

            var a = []int32{1, 2, 3}
            Console.WriteLine(a.FirstOr(99))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue773_emit_").FullName;
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
