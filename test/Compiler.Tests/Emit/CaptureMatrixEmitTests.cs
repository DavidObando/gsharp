// <copyright file="CaptureMatrixEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Guardrail matrix for capturable variable kinds across sync and async lambdas.
/// Every row compiles, IL-verifies, and executes to prove capture slot discovery,
/// boxing, and async hoist resolution stay in sync.
/// </summary>
public class CaptureMatrixEmitTests
{
    public static IEnumerable<object[]> Cases()
    {
        yield return Row("OrdinaryLocal_SyncLambda", """
            package CaptureMatrixOrdinaryLocalSync
            import System

            func Main() {
                let x = 41
                let f = () -> x + 1
                Console.WriteLine(f())
            }
            """, "42\n");

        yield return Row("OrdinaryLocal_AsyncLambda", """
            package CaptureMatrixOrdinaryLocalAsync
            import System
            import System.Threading.Tasks

            func Echo(v int32) Task[int32] -> Task.FromResult(v)

            func Main() {
                let x = 41
                let f = async () -> await Echo(x + 1)
                Console.WriteLine(f().Result)
            }
            """, "42\n");

        yield return Row("Parameter_SyncLambda", """
            package CaptureMatrixParameterSync
            import System

            func Run(value int32) int32 {
                let f = () -> value + 1
                return f()
            }

            func Main() -> Console.WriteLine(Run(41))
            """, "42\n");

        yield return Row("Parameter_AsyncLambda", """
            package CaptureMatrixParameterAsync
            import System
            import System.Threading.Tasks

            func Echo(v int32) Task[int32] -> Task.FromResult(v)

            func Run(value int32) int32 {
                let f = async () -> await Echo(value + 1)
                return f().Result
            }

            func Main() -> Console.WriteLine(Run(41))
            """, "42\n");

        yield return Row("This_SyncLambda", """
            package CaptureMatrixThisSync
            import System

            class Worker() {
                var Value int32 = 41
                func Run() int32 {
                    let f = () -> this.Value + 1
                    return f()
                }
            }

            func Main() -> Console.WriteLine(Worker().Run())
            """, "42\n");

        yield return Row("This_AsyncLambda", """
            package CaptureMatrixThisAsync
            import System
            import System.Threading.Tasks

            func Echo(v int32) Task[int32] -> Task.FromResult(v)

            class Worker() {
                var Value int32 = 41
                func Run() int32 {
                    let f = async () -> await Echo(this.Value + 1)
                    return f().Result
                }
            }

            func Main() -> Console.WriteLine(Worker().Run())
            """, "42\n");

        yield return Row("CatchVariable_SyncLambda", """
            package CaptureMatrixCatchSync
            import System

            func Main() {
                try { throw Exception("forty-two") } catch (exc Exception) {
                    let f = () -> exc.Message.Length + 33
                    Console.WriteLine(f())
                }
            }
            """, "42\n");

        yield return Row("CatchVariable_AsyncLambda", """
            package CaptureMatrixCatchAsync
            import System
            import System.Threading.Tasks

            func Echo(v int32) Task[int32] -> Task.FromResult(v)

            func Main() {
                try { throw Exception("forty-two") } catch (exc Exception) {
                    let f = async () -> await Echo(exc.Message.Length + 33)
                    Console.WriteLine(f().Result)
                }
            }
            """, "42\n");

        yield return Row("PatternSwitchBinding_SyncLambda", """
            package CaptureMatrixPatternSwitchSync
            import System

            func Main() {
                switch object("forty-two") {
                    case s is string {
                        let f = () -> s.Length + 33
                        Console.WriteLine(f())
                    }
                    default { Console.WriteLine(0) }
                }
            }
            """, "42\n");

        yield return Row("PatternSwitchBinding_AsyncLambda", """
            package CaptureMatrixPatternSwitchAsync
            import System
            import System.Threading.Tasks

            func Echo(v int32) Task[int32] -> Task.FromResult(v)

            func Main() {
                switch object("forty-two") {
                    case s is string {
                        let f = async () -> await Echo(s.Length + 33)
                        Console.WriteLine(f().Result)
                    }
                    default { Console.WriteLine(0) }
                }
            }
            """, "42\n");

        yield return Row("SwitchExpressionBinding_SyncLambda", """
            package CaptureMatrixSwitchExpressionSync
            import System

            func Make(o object) (() -> int32) {
                return switch o {
                    case s is string: () -> s.Length + 33
                    default: () -> 0
                }
            }

            func Main() -> Console.WriteLine(Make("forty-two")())
            """, "42\n");

        yield return Row("SwitchExpressionBinding_AsyncLambda", """
            package CaptureMatrixSwitchExpressionAsync
            import System
            import System.Threading.Tasks

            func Echo(v int32) Task[int32] -> Task.FromResult(v)

            func Make(o object) (() -> Task[int32]) {
                return switch o {
                    case s is string: async () -> await Echo(s.Length + 33)
                    default: async () -> await Echo(0)
                }
            }

            func Main() -> Console.WriteLine(Make("forty-two")().Result)
            """, "42\n");

        yield return Row("SelectReceiveBinding_SyncLambda", """
            package CaptureMatrixSelectSync
            import System
            import Gsharp.Extensions.Go

            func Main() {
                let ch = make(chan int32, 1)
                ch <- 41
                select {
                case let v = <-ch {
                    let f = () -> v + 1
                    Console.WriteLine(f())
                }
                }
            }
            """, "42\n");

        yield return Row("SelectReceiveBinding_AsyncLambda", """
            package CaptureMatrixSelectAsync
            import System
            import System.Threading.Tasks
            import Gsharp.Extensions.Go

            func Echo(v int32) Task[int32] -> Task.FromResult(v)

            func Main() {
                let ch = make(chan int32, 1)
                ch <- 41
                select {
                case let v = <-ch {
                    let f = async () -> await Echo(v + 1)
                    Console.WriteLine(f().Result)
                }
                }
            }
            """, "42\n");

        yield return Row("TransitiveNestedLambda_SyncLambda", """
            package CaptureMatrixTransitiveSync
            import System

            func Main() {
                let x = 41
                let outer = () -> () -> x + 1
                let inner = outer()
                Console.WriteLine(inner())
            }
            """, "42\n");

        yield return Row("TransitiveNestedLambda_AsyncLambda", """
            package CaptureMatrixTransitiveAsync
            import System
            import System.Threading.Tasks

            func Echo(v int32) Task[int32] -> Task.FromResult(v)

            func Main() {
                let x = 41
                let outer = () -> async () -> await Echo(x + 1)
                let inner = outer()
                Console.WriteLine(inner().Result)
            }
            """, "42\n");

        yield return Row("Issue2662_ExactOahuCliApp", """
            package Oahu.Cli.App
            import System
            import System.Collections.Generic

            class JobUpdate {
                var JobId string = ""
                var Value int32 = 0
            }

            class JobScheduler {
                init() {}

                async func Drain(predicate Func[JobUpdate, bool]) IAsyncEnumerable[JobUpdate] {
                    let update = JobUpdate()
                    update.JobId = "job-42"
                    update.Value = 42
                    if predicate(update) {
                        yield update
                    }
                }

                async func ObserveAsync(jobId string) IAsyncEnumerable[JobUpdate] {
                    await for u in this.Drain(u -> u.JobId == jobId) {
                        yield u
                    }
                }
            }

            func Main() {
                let e = JobScheduler().ObserveAsync("job-42").GetAsyncEnumerator()
                if e.MoveNextAsync().AsTask().Result {
                    Console.WriteLine(e.Current.Value)
                }
            }
            """, "42\n");

        yield return Row("Issue2662_ExactOahuCliAppAudibleJobExecutor_2ff82b6ad30d", """
            package Oahu.Cli.App
            import System
            import System.Collections.Generic
            import System.IO
            import System.Threading.Tasks

            class JobUpdate {
                var Value int32 = 0
            }

            class AudibleJobExecutor {
                async func ExecuteAsync(skip bool) IAsyncEnumerable[JobUpdate] {
                    if skip {
                        goto iteratorExit
                    }
                    using let resource = MemoryStream()
                    let first = JobUpdate()
                    first.Value = 42
                    let runTask = Task.CompletedTask
                    try {
                        if await Task.FromResult(true) {
                            yield first
                        }
                    } finally {
                        try {
                            await runTask
                        } catch (Exception) {
                        }
                    }
                    iteratorExit:
                    {
                    }
                }
            }

            func Main() {
                let e = AudibleJobExecutor().ExecuteAsync(false).GetAsyncEnumerator()
                var total = 0
                if e.MoveNextAsync().AsTask().Result {
                    total = total + e.Current.Value
                }
                Console.WriteLine(total)
            }
            """, "42\n");

        yield return Row("Issue2662_AudibleJobExecutor_YieldsOnlyTry", """
            package Oahu.Cli.App
            import System
            import System.Collections.Generic

            class AudibleJobExecutor {
                async func ExecuteAsync() IAsyncEnumerable[int32] {
                    try {
                        yield 42
                    } finally {
                    }
                }
            }

            func Main() {
                let e = AudibleJobExecutor().ExecuteAsync().GetAsyncEnumerator()
                if e.MoveNextAsync().AsTask().Result {
                    Console.WriteLine(e.Current)
                }
            }
            """, "42\n");

        yield return Row("Issue2662_ExactOahuCliAppJsonlHistoryStore_8aff8d9048f7", """
            package Oahu.Cli.App
            import System
            import System.Collections.Generic
            import System.IO
            import System.Threading.Tasks

            class JobRecord {
                var Value int32 = 0
            }

            class JsonlHistoryStore {
                async func ReadAllAsync(skip bool) IAsyncEnumerable[JobRecord] {
                    if skip {
                        goto iteratorExit
                    }
                    using let reader = MemoryStream()
                    var done = false
                    while !done {
                        let line = await Task.FromResult("42")
                        var rec JobRecord? = nil
                        try {
                            rec = JobRecord()
                            rec!!.Value = Int32.Parse(line)
                        } catch (Exception) {
                        }
                        if rec != nil {
                            yield rec!!
                        }
                        done = true
                    }
                    iteratorExit:
                    {
                    }
                }
            }

            func Main() {
                let e = JsonlHistoryStore().ReadAllAsync(false).GetAsyncEnumerator()
                if e.MoveNextAsync().AsTask().Result {
                    Console.WriteLine(e.Current.Value)
                }
            }
            """, "42\n");
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void CaptureMatrix_CompilesVerifiesAndRuns(string name, string source, string expected)
    {
        Assert.Equal(expected, CompileAndRun(name, source));
    }

    private static object[] Row(string name, string source, string expected) => new object[] { name, source, expected };

    private static string CompileAndRun(string name, string source)
    {
        var safeName = string.Concat(name.Split(Path.GetInvalidFileNameChars()));
        var root = Path.Combine(Directory.GetCurrentDirectory(), "CaptureMatrixArtifacts");
        var testDir = Path.Combine(root, safeName + "_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(testDir);
        try
        {
            var srcPath = Path.Combine(testDir, "test.gs");
            var dllPath = Path.Combine(testDir, "test.dll");
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
                $"{name}: gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            File.WriteAllText(rtConfig, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = testDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), $"{name}: dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"{name}: exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(testDir, recursive: true); } catch { }
        }
    }
}
