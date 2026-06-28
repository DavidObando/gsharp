// <copyright file="Issue1376AwaitVoidReceiverAsyncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1376: awaiting a call to a top-level receiver-clause (extension)
/// <c>async func</c> that declares no return type (a void-result <c>Task</c>)
/// must bind and emit. Before the fix the awaited call expression was typed as
/// <c>void</c> instead of <c>Task</c>, so the surrounding <c>await</c> rejected
/// it with GS0124 ("Expression must have a value"). The root cause was twofold:
/// the extension-call binder did not widen the async return type to <c>Task</c>,
/// and <c>BoundTreeRewriter.RewriteCallExpression</c> dropped the call-site
/// return-type override when it rebuilt the call after rewriting an argument
/// (e.g. a hoisted parameter becoming a state-machine field), reverting the type
/// back to the symbol's raw <c>void</c>. These tests compile programs that await
/// a void receiver-clause async func, verify the emitted IL, and assert runtime
/// output to prove the awaits actually execute in order.
/// </summary>
public class Issue1376AwaitVoidReceiverAsyncEmitTests
{
    [Fact]
    public void AwaitVoidReceiverClauseAsyncFunc_FromPlainAsync_EmitsAndRuns()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            async func (s string) PrintAsync() {
                await Task.Delay(1)
                Console.WriteLine(s)
            }

            async func RunAsync() {
                await "hello".PrintAsync()
                await "world".PrintAsync()
            }

            RunAsync().GetAwaiter().GetResult()
            """;

        Assert.Equal("hello\nworld\n", CompileAndRun(source));
    }

    [Fact]
    public void AwaitVoidReceiverClauseAsyncFunc_FromAnotherReceiverClauseAsync_EmitsAndRuns()
    {
        // The awaiting function is itself a void receiver-clause async func, and
        // it awaits another void receiver-clause async func whose call carries a
        // hoisted argument (the receiver). This exercises the RewriteCallExpression
        // return-type-preservation path on both ends.
        var source = """
            package P
            import System
            import System.Threading.Tasks

            async func (s string) StepAsync(label string) {
                await Task.Delay(1)
                Console.WriteLine(label + ":" + s)
            }

            async func (s string) RunAsync() {
                await s.StepAsync("a")
                await s.StepAsync("b")
            }

            "x".RunAsync().GetAwaiter().GetResult()
            """;

        Assert.Equal("a:x\nb:x\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1376_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
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
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");

            // (a) Static verification: the emitted IL must be valid.
            IlVerifier.Verify(outPath);

            // (b) Dynamic verification: the emitted code must execute.
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
