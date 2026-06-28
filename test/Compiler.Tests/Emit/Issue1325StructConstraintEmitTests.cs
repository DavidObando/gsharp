// <copyright file="Issue1325StructConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1325: end-to-end emit + execution test proving that a generic method
/// with a <c>where T : struct</c> constraint resolves, binds, and emits
/// verifiable IL when the type argument is a SAME-COMPILATION user-defined
/// struct — exercised through
/// <see cref="System.Runtime.InteropServices.MemoryMarshal"/>'s
/// <c>AsBytes&lt;T&gt;</c> (inferred type argument) and
/// <c>Cast&lt;TFrom, TTo&gt;</c> (explicit type arguments).
/// <para>
/// Before the fix the user struct was erased to a <c>System.Object</c>
/// placeholder, failing the value-type/struct constraint check, and the call
/// was rejected with <c>GS0159</c>. The emitted MethodSpec must carry the real
/// user-struct TypeDef token (not <c>object</c>) so the reinterpretation
/// computes the correct element size at runtime. This test compiles via
/// <c>gsc</c>, ilverifies (no tolerated codes — the IL must be fully
/// verifiable), and executes to assert the reinterpreted bytes/uint32 values.
/// </para>
/// </summary>
public class Issue1325StructConstraintEmitTests
{
    [Fact]
    public void UserStructSpan_MemoryMarshalAsBytesAndCast_CompilesVerifiesAndRuns()
    {
        const string source = """
            package Probe
            import System
            import System.Runtime.InteropServices

            struct E { var a int32 }

            func run() {
                var arr []E = []E{E{a: int32(0x01020304)}, E{a: int32(0x05060708)}}
                var sp Span[E] = arr.AsSpan()
                var bytes = MemoryMarshal.AsBytes(sp)
                Console.WriteLine(bytes.Length)
                var u = MemoryMarshal.Cast[E, uint32](sp)
                Console.WriteLine(u.Length)
                Console.WriteLine(u[0])
                Console.WriteLine(u[1])
            }

            run()
            """;

        // The reinterpretation is fully verifiable; no tolerated codes.
        var output = CompileAndRun(source, Array.Empty<string>());

        // 2 E (4 bytes each) -> 8 bytes; cast to uint32 -> 2 elements whose
        // little-endian values are the original int32 fields.
        Assert.Equal("8\n2\n16909060\n84281096\n", output);
    }

    private static string CompileAndRun(string source, string[] ilVerifyIgnored)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1325_").FullName;
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

            IlVerifier.Verify(outPath, null, ilVerifyIgnored);

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
