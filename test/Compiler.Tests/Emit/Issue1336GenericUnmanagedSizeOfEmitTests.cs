// <copyright file="Issue1336GenericUnmanagedSizeOfEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1336 / Refs #914: end-to-end emit + execution tests for unsafe
/// generic SIMD-style code over an <c>unmanaged</c>-constrained type parameter
/// <c>T</c>. Covers two capabilities the real Oahu corpus needs:
/// <list type="number">
/// <item><c>sizeof(T)</c> over a generic <c>T : unmanaged</c> — lowered to the
/// CIL <c>sizeof</c> opcode over a generic type token. This is fully
/// verifiable IL.</item>
/// <item><c>*T</c> (a pointer to the type parameter) over <c>T : unmanaged</c>.
/// Like all raw-pointer code this is unverifiable by design, so the inherent
/// pointer error codes are tolerated while still gating other regressions.</item>
/// </list>
/// </summary>
public class Issue1336GenericUnmanagedSizeOfEmitTests
{
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    [Fact]
    public void SizeOfGenericUnmanaged_CompilesVerifiesAndRuns()
    {
        var source = """
            package Probe
            import System

            func sizeOf[T unmanaged](sample T) int32 {
                return sizeof(T)
            }

            func run() {
                var a uint8 = 0
                var b int32 = 0
                var c int64 = 0
                Console.WriteLine(sizeOf(a))
                Console.WriteLine(sizeOf(b))
                Console.WriteLine(sizeOf(c))
            }

            run()
            """;

        // sizeof over a generic type token is fully verifiable IL: no ignored
        // codes — any verification error fails the test. The type argument is
        // inferred from the typed local, so each instantiation emits a distinct
        // generic `sizeof !!T`.
        var output = CompileAndRun(source, Array.Empty<string>());
        Assert.Equal("1\n4\n8\n", output);
    }

    [Fact]
    public void SizeOfGenericUnmanaged_VecLaneCount_CompilesAndRuns()
    {
        // Mirrors the Oahu driver: 256 / 8 / sizeof(T) lane count.
        var source = """
            package Probe
            import System

            func laneCount[T unmanaged](sample T) int32 {
                return 256 / 8 / sizeof(T)
            }

            func run() {
                var a uint8 = 0
                var b int16 = 0
                var c int32 = 0
                Console.WriteLine(laneCount(a))
                Console.WriteLine(laneCount(b))
                Console.WriteLine(laneCount(c))
            }

            run()
            """;

        var output = CompileAndRun(source, Array.Empty<string>());
        Assert.Equal("32\n16\n8\n", output);
    }

    [Fact]
    public void PointerToGenericUnmanaged_CompilesVerifiesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func writeFirst[T unmanaged](arr []T, value T) {
                var p = &arr[0]
                *p = value
            }

            unsafe func run() {
                var arr = []int32{0, 0, 0}
                writeFirst[int32](arr, 42)
                Console.WriteLine(arr[0])
            }

            run()
            """;

        // Raw pointer code is unverifiable by design; tolerate the inherent
        // pointer codes while still gating other verification regressions.
        var output = CompileAndRun(source, UnsafeIlVerifyIgnored);
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source, string[] ignoredIlVerifyCodes)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1336_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
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
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath, null, ignoredIlVerifyCodes);

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
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

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
                // ignored
            }
        }
    }
}
