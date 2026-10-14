// <copyright file="Issue2773EagerEnumerableReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

class Issue2773EagerEnumerableReturnEmitTests {
    @Fact
    func NoYieldWrappersExecuteEagerly_WhileYieldBodiesRemainLazy_VerifyAndRun() {
        const source = `package Issue2773

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

Console.WriteLine(Probe().Run().GetAwaiter().GetResult())`
        Assert.Equal(
            "sync-call|user-call|async-call${Environment.NewLine}" +
                "sync-call|user-call|async-call|sync-yield|sync-finally|user-yield|user-finally|async-yield|async-finally${Environment.NewLine}" +
                "6${Environment.NewLine}",
            CompileVerifyAndRun(source)
        )
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(
                Directory.GetCurrentDirectory(),
                "out",
                "test-artifacts",
                "issue2773-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{
                            "/out:" + outputPath,
                            "/target:exe",
                            "/targetframework:net10.0",
                            "/nowarn:GS9100",
                            sourcePath
                        }
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed:
` + "$compileOut" + `
` + "$compileErr"))
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo)!!
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }
    }
}
