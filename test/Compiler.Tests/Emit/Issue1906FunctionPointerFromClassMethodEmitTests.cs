// <copyright file="Issue1906FunctionPointerFromClassMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1906: <c>&amp;Method</c> (<c>ldftn</c>, ADR-0122 §9) taken on a
/// <c>shared</c> method declared inside a class/struct — as opposed to a
/// top-level package function (already covered by
/// <see cref="Issue1035FunctionPointerEmitTests"/>) — used to throw
/// <c>InvalidOperationException: Function 'X' has no emitted MethodDef for
/// '&amp;X' (ldftn)</c> at compile time: the emitter only consulted
/// <c>MetadataTokenCache.FunctionHandles</c> (top-level functions), never
/// <c>MetadataTokenCache.MethodHandles</c> (class/struct methods), so a
/// method reachable ONLY via its address (never called directly) had no
/// registered <c>MethodDef</c> to reference. This surfaced when the cs2gs
/// translator started mapping C# <c>delegate*&lt;...&gt;</c> to G#'s managed
/// function-pointer form, since a translated C# static method lives in a
/// <c>shared {}</c> block, not as a free function.
/// </summary>
public class Issue1906FunctionPointerFromClassMethodEmitTests
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
    public void FunctionPointer_AddressOfSharedClassMethod_CompilesAndRuns()
    {
        const string source = """
            package Probe
            import System

            class Calc {
                shared {
                    unsafe func Square(value int32) int32 {
                        return value * value
                    }
                }
            }

            unsafe func run() {
                let fp *func(int32) int32 = &Calc.Square
                Console.WriteLine(fp(6))
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("36\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1906_").FullName;
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
