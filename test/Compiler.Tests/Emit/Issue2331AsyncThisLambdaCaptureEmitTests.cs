// <copyright file="Issue2331AsyncThisLambdaCaptureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2331: a nested lambda that captures <c>this</c> inside a
/// <c>Task</c>-returning <c>async func</c> instance method used to fail at
/// emit with GS9998 <c>InvalidOperationException: Variable 'this' has no
/// local slot or parameter index in the current method.</c>
/// </summary>
/// <remarks>
/// <para>
/// Root cause: <see cref="Core.CodeAnalysis.Lowering.Async.AsyncStateMachineFieldMap.TryGetHoistedField"/>
/// is the single source of truth both the <c>MoveNext</c> body rewriter and
/// the emitter's closure-construction site (<c>EmitCapturedVariableLoad</c>
/// in <c>MethodBodyEmitter.Closures.cs</c>) rely on to decide whether a
/// captured variable resolves to a state-machine field read instead of an
/// ordinary local/parameter load. <c>this</c> is always hoisted into
/// <c>ThisField</c> for an instance-method state machine, but that lookup
/// only special-cased <c>this</c> in the private copy inside
/// <c>MoveNextBodyRewriter</c>: the public <c>TryGetHoistedField</c> consulted
/// by the emitter when constructing a captured-`this` closure did not, so the
/// closure-construction site fell back to treating the kickoff method's
/// (now-hoisted, slot-less) <c>ThisParameter</c> as an ordinary local/param
/// load and the emitter's slot lookup threw. Adding the same <c>this</c>
/// special case to the shared field map closes the gap for every caller at
/// once — including nested lambdas transitively reachable from the async
/// body — without touching the emitter's slot-lookup logic itself.
/// </para>
/// <para>These tests exercise the five shapes called out by the issue: an
/// implicit-<c>this</c> instance call, an explicit <c>this.field</c> read, a
/// lambda that captures both <c>this</c> and an ordinary local, a doubly
/// nested lambda capturing <c>this</c>, and the exact Oahu
/// <c>await Task.Run(() =&gt; InstanceMethod())</c> shape. Non-async and
/// local-only-capture async controls are included to prove the existing
/// behavior stays green.</para>
/// </remarks>
public class Issue2331AsyncThisLambdaCaptureEmitTests
{
    [Fact]
    public void AsyncInstanceMethod_LambdaImplicitThisCapture_InstanceCall_Runs()
    {
        // Exact issue repro shape: `await Task.Run(() -> Do())` where `Do()`
        // is an implicit-`this` instance call inside the nested lambda.
        const string source = """
            package i2331implicit
            import System
            import System.Threading.Tasks

            class Worker() {
                async func RunAsync() -> await Task.Run(() -> Do())
                func Do() { Console.WriteLine("x") }
            }

            let w = Worker()
            w.RunAsync().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("x\n", output);
    }

    [Fact]
    public void AsyncInstanceMethod_LambdaExplicitThisField_Runs()
    {
        const string source = """
            package i2331explicit
            import System
            import System.Threading.Tasks

            class Worker() {
                var Value int32 = 41
                async func RunAsync() -> await Task.Run(() -> Console.WriteLine(this.Value + 1))
            }

            let w = Worker()
            w.RunAsync().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void AsyncInstanceMethod_LambdaMixedThisAndLocalCapture_Runs()
    {
        const string source = """
            package i2331mixed
            import System
            import System.Threading.Tasks

            class Worker() {
                var Value int32 = 10
                async func RunAsync(extra int32) {
                    let local = 5
                    await Task.Run(() -> Console.WriteLine(this.Value + local + extra))
                }
            }

            let w = Worker()
            w.RunAsync(2).Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("17\n", output);
    }

    [Fact]
    public void AsyncInstanceMethod_DoublyNestedLambdaCapturingThis_Runs()
    {
        const string source = """
            package i2331doublenested
            import System
            import System.Threading.Tasks

            class Worker() {
                var Value int32 = 100
                async func RunAsync() {
                    await Task.Run(() -> {
                        let inner = () -> Console.WriteLine(this.Value)
                        inner()
                    })
                }
            }

            let w = Worker()
            w.RunAsync().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("100\n", output);
    }

    [Fact]
    public void AsyncInstanceMethod_OahuTaskRunCleanupShape_Runs()
    {
        // Mirrors the real Oahu occurrence quoted in the issue:
        //   public async Task CleanupAsync() => await Task.Run(() => Cleanup());
        const string source = """
            package i2331oahu
            import System
            import System.Threading.Tasks

            class Resource() {
                async func CleanupAsync() -> await Task.Run(() -> Cleanup())
                func Cleanup() { Console.WriteLine("cleaned") }
            }

            let r = Resource()
            r.CleanupAsync().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("cleaned\n", output);
    }

    [Fact]
    public void Control_NonAsync_LambdaCapturingThis_StillRuns()
    {
        // Non-regression control: the same nested-lambda-captures-this shape
        // outside of async lowering must remain unaffected by this fix.
        const string source = """
            package i2331controlsync
            import System

            class Worker() {
                func Do() { Console.WriteLine("nonasync") }
                func RunSync() -> (() -> Do())()
            }

            let w = Worker()
            w.RunSync()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("nonasync\n", output);
    }

    [Fact]
    public void Control_AsyncMethod_LambdaCapturingOnlyLocal_StillRuns()
    {
        // Non-regression control: the pre-existing working case of an async
        // method whose nested lambda captures only an ordinary local (no
        // `this` involved at all — including static/free functions).
        const string source = """
            package i2331controllocal
            import System
            import System.Threading.Tasks

            async func RunAsync() {
                let local = 7
                await Task.Run(() -> Console.WriteLine(local))
            }

            RunAsync().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2331_exe_").FullName;
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
