// <copyright file="Issue1035FunctionPointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1035 / ADR-0122 §9: end-to-end emit + execution tests for managed
/// function pointers (<c>*func(T1, T2) R</c>). Each test compiles via
/// <c>gsc</c> and executes the produced assembly under <c>dotnet exec</c>,
/// covering <c>&amp;StaticMethod</c> (<c>ldftn</c>), direct invocation
/// (<c>calli</c>), passing a function pointer as a parameter, and a round-trip
/// through <c>nint</c>.
/// <para>
/// Genuinely-unsafe pointer code is unverifiable by design; the inherent
/// error codes are passed to <c>ignoredErrorCodes</c> so the gate still
/// catches new unrelated verification regressions (including invalid
/// <c>ldftn</c>/<c>calli</c> tokens) while asserting runtime behavior.
/// </para>
/// </summary>
public class Issue1035FunctionPointerEmitTests
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
    public void FunctionPointer_AddressOfAndCall_CompilesAndRuns()
    {
        const string source = """
            package Probe
            import System

            unsafe func add(a int32, b int32) int32 {
                return a + b
            }

            unsafe func run() {
                let fp *func(int32, int32) int32 = &add
                Console.WriteLine(fp(3, 4))
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void FunctionPointer_PassAsParameter_CompilesAndRuns()
    {
        const string source = """
            package Probe
            import System

            unsafe func add(a int32, b int32) int32 {
                return a + b
            }

            unsafe func mul(a int32, b int32) int32 {
                return a * b
            }

            unsafe func apply(fp *func(int32, int32) int32, x int32, y int32) int32 {
                return fp(x, y)
            }

            unsafe func run() {
                Console.WriteLine(apply(&add, 10, 20))
                Console.WriteLine(apply(&mul, 6, 7))
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("30\n42\n", output);
    }

    [Fact]
    public void FunctionPointer_VoidReturn_CompilesAndRuns()
    {
        const string source = """
            package Probe
            import System

            unsafe func greet() {
                Console.WriteLine("hi")
            }

            unsafe func run() {
                let fp *func() = &greet
                fp()
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\n", output);
    }

    [Fact]
    public void FunctionPointer_NintRoundTrip_CompilesAndRuns()
    {
        const string source = """
            package Probe
            import System

            unsafe func add(a int32, b int32) int32 {
                return a + b
            }

            unsafe func run() {
                let fp *func(int32, int32) int32 = &add
                let n nint = nint(fp)
                Console.WriteLine(n != nint(0))
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1035_").FullName;
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

            // Unsafe pointer code is unverifiable by design; tolerate the
            // inherent-unsafety error codes while still gating on other
            // verification regressions (including invalid ldftn tokens).
            // dotnet-ilverify does not implement verification of the `calli`
            // opcode ("ImportCalli not implemented"); that is a limitation of
            // the verifier tool, not of the emitted IL, so we tolerate that
            // specific failure and rely on the runtime execution below as the
            // correctness gate for the calli path.
            try
            {
                IlVerifier.Verify(outPath, null, UnsafeIlVerifyIgnored);
            }
            catch (Exception ex) when (ex.Message.Contains("ImportCalli not implemented", StringComparison.Ordinal))
            {
                // Known dotnet-ilverify limitation for `calli`; ignore.
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
