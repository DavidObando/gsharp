// <copyright file="Issue2331AsyncCaptureHoistEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2331 (deferred half): <see cref="Core.CodeAnalysis.Lowering.Async.AsyncCaptureWalker"/>'s
/// reference collector did not recurse into nested lambda bodies, so an
/// ordinary local or parameter whose only reference anywhere in an async
/// method was inside a nested lambda could, in principle, be missed by hoist
/// discovery. In practice <c>CaptureBoxingRewriter</c> (which runs before
/// state-machine lowering) already forces every boxable captured
/// local/parameter's box declaration to live at the original outer-scope
/// declaration site, which independently prevented this from being an
/// observable runtime bug for ordinary (non-<c>this</c>) captures. This fix
/// closes the gap at the source: <c>AsyncCaptureWalker.ReferenceCollector</c>
/// now overrides <c>RewriteFunctionLiteralExpression</c> and records each
/// lambda literal's own (transitively binder-flattened, issue #503)
/// <c>CapturedVariables</c> via a dedicated <c>LambdaCaptureCollector</c>
/// helper, instead of relying implicitly on the boxing side effect. The
/// helper deliberately never overrides variable-declaration/reference
/// rewrites, so a lambda's own locally-declared locals are never
/// accidentally hoisted into the outer async state machine.
/// </summary>
/// <remarks>
/// These tests force genuine `MoveNext` suspension via <c>await Task.Yield()</c>
/// before the lambda executes, so a value that only survives correctly by
/// virtue of the state machine's field storage (rather than happening to
/// still be on the stack because the prior await completed synchronously)
/// is actually exercised.
/// </remarks>
public class Issue2331AsyncCaptureHoistEmitTests
{
    [Fact]
    public void AsyncMethod_LocalDeclaredBeforeAwait_ReferencedOnlyInsideLambdaAfterAwait_Runs()
    {
        const string source = """
            package i2331localafterlambda
            import System
            import System.Threading.Tasks

            async func RunAsync() {
                let x = 42
                await Task.Yield()
                await Task.Run(() -> Console.WriteLine(x))
            }

            RunAsync().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void AsyncMethod_ParameterReferencedOnlyInsideLambdaAfterAwait_Runs()
    {
        const string source = """
            package i2331paramonlylambda
            import System
            import System.Threading.Tasks

            async func RunAsync(value int32) {
                await Task.Yield()
                await Task.Run(() -> Console.WriteLine(value))
            }

            RunAsync(99).Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void AsyncMethod_DoublyNestedLambda_CapturingOuterLocalAfterAwait_Runs()
    {
        const string source = """
            package i2331doublenestedlocal
            import System
            import System.Threading.Tasks

            async func RunAsync() {
                let x = 14
                await Task.Yield()
                await Task.Run(() -> {
                    let inner = () -> Console.WriteLine(x)
                    inner()
                })
            }

            RunAsync().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("14\n", output);
    }

    [Fact]
    public void AsyncInstanceMethod_MixedThisAndLocalAndParameter_ReferencedOnlyInsideLambdaAfterAwait_Runs()
    {
        const string source = """
            package i2331mixedafterlambda
            import System
            import System.Threading.Tasks

            class Worker() {
                var Value int32 = 3
                async func RunAsync(extra int32) {
                    let local = 4
                    await Task.Yield()
                    await Task.Run(() -> Console.WriteLine(this.Value + local + extra))
                }
            }

            let w = Worker()
            w.RunAsync(10).Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("17\n", output);
    }

    [Fact]
    public void Control_LambdaOwnLocal_NotHoisted_OuterAsyncMethod_StillRunsCorrectly()
    {
        // Control: the lambda's own local (`ownLocal`) must not be
        // incorrectly hoisted into the outer async method's state machine.
        // If it were misclassified as an outer local needing hoisting, it
        // would either fail to compile (declared twice) or shadow/alias
        // across invocations; this proves the computed sum is correct and
        // stable across two separate calls with different closure state.
        const string source = """
            package i2331lambdaownlocalcontrol
            import System
            import System.Threading.Tasks

            async func RunAsync(seed int32) int32 {
                let outer = seed
                await Task.Yield()
                let f = () -> {
                    let ownLocal = 100
                    return outer + ownLocal
                }
                return f()
            }

            Console.WriteLine(RunAsync(1).Result)
            Console.WriteLine(RunAsync(2).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("101\n102\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2331hoist_exe_").FullName;
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
