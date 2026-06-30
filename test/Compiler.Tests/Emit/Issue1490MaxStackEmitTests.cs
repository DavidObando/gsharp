// <copyright file="Issue1490MaxStackEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1490 — method bodies were emitted with the default <c>.maxstack 8</c>
/// because every <c>MethodBodyStreamEncoder.AddMethodBody</c> call omitted the
/// <c>maxStack</c> argument. Any body whose evaluation-stack peak exceeds eight
/// (a many-argument call/constructor, a deeply nested arithmetic expression, an
/// async <c>MoveNext</c> state machine, …) emitted invalid IL that
/// <c>ilverify</c> rejected with <c>StackOverflow</c>.
/// <para>
/// Each facet below produced a stack peak greater than 8 and failed ilverify on
/// current main; all pass after the fix, which now declares a computed
/// <c>.maxstack</c> for every emitted body. The four facets exercise the
/// distinct body-emission paths: a normal method (many-arg <c>newobj</c>), a
/// deeply nested arithmetic expression, an <c>async</c> method (the
/// <c>MoveNext</c> state-machine path) and a constructor body.
/// </para>
/// </summary>
public class Issue1490MaxStackEmitTests
{
    [Fact]
    public void EndToEnd_ManyArgumentGuidConstructor_Verifies()
    {
        var source = """
            package Probe1490Guid
            import System

            class Rng1490 {
                var n int32
                init() { n = 0 }
                func Next(bits int32) int64 {
                    n = n + bits
                    return int64(n)
                }
            }

            func Main() {
                let r = Rng1490()
                let g = System.Guid(
                    uint32(r.Next(32)),
                    uint16(r.Next(16)),
                    uint16(r.Next(16)),
                    uint8(r.Next(8)),
                    uint8(r.Next(8)),
                    uint8(r.Next(8)),
                    uint8(r.Next(8)),
                    uint8(r.Next(8)),
                    uint8(r.Next(8)),
                    uint8(r.Next(8)),
                    uint8(r.Next(8)))
                Console.WriteLine(g.ToString().Length)
                Console.WriteLine("ok1490guid")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("36\nok1490guid\n", output);
    }

    [Fact]
    public void EndToEnd_DeeplyNestedArithmeticExpression_Verifies()
    {
        var source = """
            package Probe1490Nested
            import System

            func Deep1490(a int32, b int32, c int32, d int32, e int32, f int32, g int32, h int32) int32 {
                return ((((a + b) * (c + d)) - ((e + f) * (g + h)))
                    + ((((a * c) + (b * d)) - ((e * g) + (f * h))))
                    + (((a + e) * (b + f)) - ((c + g) * (d + h))))
            }

            func Main() {
                Console.WriteLine(Deep1490(1, 2, 3, 4, 5, 6, 7, 8))
                Console.WriteLine("ok1490nested")
            }
            """;

        var output = CompileAndRun(source);
        Assert.EndsWith("ok1490nested\n", output);
    }

    [Fact]
    public void EndToEnd_AsyncMethodWithDeepBody_Verifies()
    {
        var source = """
            package Probe1490Async
            import System
            import System.Threading.Tasks

            class Acc1490 {
                var n int32
                init() { n = 0 }
                func Next(bits int32) int64 {
                    n = n + bits
                    return int64(n)
                }
            }

            class Worker1490 {
                async func BuildAsync() string {
                    let a = Acc1490()
                    await Task.Delay(1)
                    let g = System.Guid(
                        uint32(a.Next(32)),
                        uint16(a.Next(16)),
                        uint16(a.Next(16)),
                        uint8(a.Next(8)),
                        uint8(a.Next(8)),
                        uint8(a.Next(8)),
                        uint8(a.Next(8)),
                        uint8(a.Next(8)),
                        uint8(a.Next(8)),
                        uint8(a.Next(8)),
                        uint8(a.Next(8)))
                    return g.ToString()
                }
            }

            func Main() {
                let w = Worker1490()
                let t = w.BuildAsync()
                t.Wait()
                Console.WriteLine(t.Result.Length)
                Console.WriteLine("ok1490async")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("36\nok1490async\n", output);
    }

    [Fact]
    public void EndToEnd_ConstructorWithManyArgumentCall_Verifies()
    {
        var source = """
            package Probe1490Ctor
            import System

            class Holder1490 {
                var s string
                init() {
                    let g = System.Guid(
                        uint32(1),
                        uint16(2),
                        uint16(3),
                        uint8(4),
                        uint8(5),
                        uint8(6),
                        uint8(7),
                        uint8(8),
                        uint8(9),
                        uint8(10),
                        uint8(11))
                    s = g.ToString()
                }
            }

            func Main() {
                let h = Holder1490()
                Console.WriteLine(h.s.Length)
                Console.WriteLine("ok1490ctor")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("36\nok1490ctor\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1490_exe_").FullName;
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
