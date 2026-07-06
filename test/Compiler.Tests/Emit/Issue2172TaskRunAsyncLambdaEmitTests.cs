// <copyright file="Issue2172TaskRunAsyncLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2172: <c>Task.Run(async () -&gt; await ...)</c>, where the async
/// lambda awaits a <c>Task[T]</c>, must resolve to the
/// <c>Task.Run(Func&lt;Task&lt;TResult&gt;&gt;)</c> overload (returning
/// <c>Task[X]</c>) rather than being ambiguous with
/// <c>Task.Run(Func&lt;TResult&gt;)</c> (which would return
/// <c>Task[Task[X]]</c>). These emit tests prove the resolved call not only
/// compiles but produces IL that runs and returns the awaited result correctly.
/// A parallel test covers a user-defined overload set (NOT <c>Task.Run</c>) to
/// prove the betterness rule is generalized, not hard-coded to the BCL method.
/// </summary>
public class Issue2172TaskRunAsyncLambdaEmitTests
{
    [Fact]
    public void TaskRun_AsyncLambda_ReturnsAwaitedResult()
    {
        const string source = """
            package i2172run
            import System
            import System.Threading.Tasks

            func makeAsync() Task[int32] -> Task.FromResult(42)

            func get() int32 {
                let task = Task.Run(async () -> await makeAsync())
                return task.Result
            }

            Console.WriteLine(get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void TaskRun_AsyncLambda_StringResult_ReturnsAwaitedResult()
    {
        const string source = """
            package i2172str
            import System
            import System.Threading.Tasks

            func makeAsync() Task[string] -> Task.FromResult("hello")

            func get() string {
                let task = Task.Run(async () -> await makeAsync())
                return task.Result
            }

            Console.WriteLine(get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void UserOverloadSet_FuncXVersusFuncTaskX_PrefersTaskReturningOverloadAtRuntime()
    {
        // Generalized (NOT Task.Run): a user-defined overload set differing only
        // by `() -> T` vs `() -> Task[T]`. The task-returning async lambda must
        // bind to the `() -> Task[T]` overload; the awaited result flows back
        // through `.Result`. If the `() -> T` overload were chosen, `run` would
        // return a Task and the `int32`-typed local would not compile.
        const string source = """
            package i2172gen
            import System
            import System.Threading.Tasks

            func makeAsync() Task[int32] -> Task.FromResult(7)

            func run(f () -> int32) int32 -> f()
            func run(f () -> Task[int32]) int32 -> f().Result

            func use() int32 -> run(async () -> await makeAsync())

            Console.WriteLine(use())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2172_exe_").FullName;
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
