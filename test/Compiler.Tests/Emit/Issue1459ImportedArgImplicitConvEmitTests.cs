// <copyright file="Issue1459ImportedArgImplicitConvEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1459 — calls to imported (CLR/BCL) methods did not apply a
/// user-defined / BCL <c>op_Implicit</c> conversion to coerce an argument to
/// the resolved parameter type, so the emitter pushed the source type directly
/// and produced unverifiable IL
/// (<c>StackUnexpected: found ref 'uint8[]' expected value 'ReadOnlySpan`1&lt;uint8&gt;'</c>).
/// The fix routes imported-call argument coercion through the same
/// user-defined-conversion fallback used by user functions
/// (<c>ConversionClassifier.BindClrParameterConversions</c> now invokes
/// <c>TryApplyUserDefinedImplicitArgumentConversion</c> when no built-in
/// conversion applies), covering <c>[]T -&gt; ReadOnlySpan[T]</c>,
/// <c>Span[T] -&gt; ReadOnlySpan[T]</c>, and <c>Memory[T] -&gt; ReadOnlyMemory[T]</c>
/// for any constructed generic with an implicit operator — not just
/// <c>ReadOnlySpan&lt;byte&gt;</c>.
/// </summary>
public class Issue1459ImportedArgImplicitConvEmitTests
{
    [Fact]
    public void EndToEnd_ByteArrayToReadOnlySpan_AtStaticImportedMethod_Runs()
    {
        var source = """
            package Probe1459a
            import System
            import System.Buffers.Binary

            func Main() {
                let arr = [4]uint8
                arr[0] = 0
                arr[1] = 0
                arr[2] = 1
                arr[3] = 0
                let v = BinaryPrimitives.ReadUInt32BigEndian(arr)
                Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("256\n", output);
    }

    [Fact]
    public void EndToEnd_ByteArrayToReadOnlySpan_AtInstanceImportedMethod_Runs()
    {
        var source = """
            package Probe1459b
            import System
            import System.IO

            func Main() {
                let ms = MemoryStream()
                let arr = [4]uint8
                ms.Write(arr)
                Console.WriteLine(ms.Length)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n", output);
    }

    [Fact]
    public void EndToEnd_SpanToReadOnlySpan_AtInstanceImportedMethod_Runs()
    {
        var source = """
            package Probe1459c
            import System
            import System.IO

            func Main() {
                let ms = MemoryStream()
                let arr = [4]uint8
                let sp = Span[uint8](arr)
                ms.Write(sp)
                Console.WriteLine(ms.Length)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n", output);
    }

    [Fact]
    public void EndToEnd_MemoryToReadOnlyMemory_AtImportedConstructor_Runs()
    {
        var source = """
            package Probe1459d
            import System
            import System.Buffers

            func Main() {
                let arr = [4]uint8
                let mem = Memory[uint8](arr)
                let seq = ReadOnlySequence[uint8](mem)
                Console.WriteLine(seq.Length)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n", output);
    }

    [Fact]
    public void EndToEnd_NonByteArrayToReadOnlySpan_Generalizes_Runs()
    {
        // Proves the fix is not byte-specific: []int32 -> ReadOnlySpan[int32]
        // resolves the constructed-generic op_Implicit too.
        var source = """
            package Probe1459e
            import System

            func Sum(s ReadOnlySpan[int32]) int32 {
                var t = 0
                var i = 0
                while i < s.Length {
                    t = t + s[i]
                    i = i + 1
                }
                return t
            }

            func Main() {
                let arr = [3]int32
                arr[0] = 5
                arr[1] = 9
                arr[2] = 2
                Console.WriteLine(Sum(arr))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("16\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1459_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
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
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
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
