// <copyright file="Issue2066NullableDelegateSnapshotEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2066 — a nullable local of a delegate type, null-guarded and then
/// invoked with direct call syntax (<c>snapshot(args)</c>, no <c>?</c> on the
/// call), crashed at bind time with <c>GS0131 'snapshot' is not a
/// function</c>. Nil-guard smart-cast narrowing (Phase 3.C.4) records that
/// <c>snapshot</c> is non-nullable inside the guarded scope, but the
/// direct-call binders in <c>OverloadResolver</c> matched only the raw
/// (nullable) declared type against the concrete delegate/function-type
/// shapes, so the narrowed-non-null case never matched and fell through to
/// the "not a function" diagnostic.
/// <para>
/// The fix threads the active smart-cast narrowing frame into the direct-call
/// dispatch so it observes the narrowed (non-nullable) delegate shape,
/// exactly as an ordinary narrowed variable read already does — covering
/// both a user-declared named delegate type (<c>type T = delegate func(...)
/// ...</c>) and a native function-typed local (<c>(T) -&gt; R</c>), any
/// arity, and both <c>void</c> and non-<c>void</c> return types.
/// </para>
/// Each test uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
/// <para>
/// Note: the first test raises the delegate via a plain public field (not a
/// field-like <c>event</c>) — a field-like event of a user-declared named
/// delegate type has a separate, unrelated accessor-emission bug (filed as
/// issue #2085) that fails ilverify regardless of how (or whether) it is
/// ever assigned, independent of the narrowing/invoke fix under test here.
/// </para>
/// </summary>
public class Issue2066NullableDelegateSnapshotEmitTests
{
    [Fact]
    public void NamedDelegate_NullableLocalSnapshot_VoidReturn_Runs()
    {
        const string source = """
            package i2066namedvoid
            import System

            type TickHandler = delegate func(count int32) void

            class Clock
            {
                public var Ticked TickHandler

                func Fire(count int32)
                {
                    let snapshot TickHandler? = this.Ticked
                    if snapshot != nil
                    {
                        snapshot(count)
                    }
                }
            }

            func OnTick(count int32) void
            {
                System.Console.WriteLine(count)
            }

            func Main()
            {
                let c = Clock()
                c.Ticked = OnTick
                c.Fire(5)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void NamedDelegate_NullableLocalSnapshot_NonVoidReturn_Runs()
    {
        const string source = """
            package i2066namedret
            import System

            type Adder = delegate func(a int32, b int32) int32

            func Main()
            {
                let concrete Adder = (a int32, b int32) -> a + b
                let snapshot Adder? = concrete
                if snapshot != nil
                {
                    System.Console.WriteLine(snapshot(3, 4))
                }
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void FunctionTypedLocal_NullableSnapshot_Runs()
    {
        const string source = """
            package i2066functype
            import System

            func Main()
            {
                let f ((int32) -> int32)? = (x int32) -> x * 2
                if f != nil
                {
                    System.Console.WriteLine(f(21))
                }
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2066_exe_").FullName;
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
