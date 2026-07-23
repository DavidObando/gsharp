// <copyright file="Issue2773EagerEnumerableReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2773EagerEnumerableReturnEmitTests
{
    [Fact]
    public void NoYieldWrappersExecuteEagerly_WhileYieldBodiesRemainLazy_VerifyAndRun()
    {
        const string source = """
            package Issue2773

            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class Item(Value int32) { }

            interface AsyncSource {
                func Async() IAsyncEnumerable[int32];
            }

            class Probe : AsyncSource {
                let events List[string] = List[string]()

                func Sync() IEnumerable[int32] {
                    events.Add("sync-call")
                    return SyncIterator()
                }

                func UserSequence() sequence[Item] {
                    events.Add("user-call")
                    return UserIterator()
                }

                func Async() IAsyncEnumerable[int32] {
                    events.Add("async-call")
                    return AsyncIterator()
                }

                private func SyncIterator() IEnumerable[int32] {
                    try {
                        events.Add("sync-yield")
                        yield 1
                    } finally {
                        events.Add("sync-finally")
                    }
                }

                private func UserIterator() sequence[Item] {
                    try {
                        events.Add("user-yield")
                        yield Item(2)
                    } finally {
                        events.Add("user-finally")
                    }
                }

                private async func AsyncIterator() IAsyncEnumerable[int32] {
                    try {
                        events.Add("async-yield")
                        await Task.Yield()
                        yield 3
                    } finally {
                        events.Add("async-finally")
                    }
                }

                async func Run() int32 {
                    let syncValues = Sync()
                    let userValues = UserSequence()
                    let source AsyncSource = this
                    let asyncValues = source.Async()
                    Console.WriteLine(String.Join("|", events))

                    var sum = 0
                    for value in syncValues {
                        sum += value
                    }
                    for value in userValues {
                        sum += value.Value
                    }
                    await for value in asyncValues {
                        sum += value
                    }

                    Console.WriteLine(String.Join("|", events))
                    return sum
                }
            }

            Console.WriteLine(Probe().Run().GetAwaiter().GetResult())
            """;

        Assert.Equal(
            "sync-call|user-call|async-call\n" +
            "sync-call|user-call|async-call|sync-yield|sync-finally|user-yield|user-finally|async-yield|async-finally\n" +
            "6\n",
            CompileVerifyAndRun(source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "test-artifacts",
            "issue2773-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"gsc failed:\n{compileOut}\n{compileErr}");
            IlVerifier.Verify(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo)!;
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\n{stderr}");
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
