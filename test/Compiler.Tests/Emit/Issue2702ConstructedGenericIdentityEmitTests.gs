// <copyright file="Issue2702ConstructedGenericIdentityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #2702: a constructed generic nested in a tuple must retain its
/// same-compilation user type argument through dictionary calls and iterator
/// state machines.
open class Issue2702ConstructedGenericIdentityEmitTests {
    @Fact
    func ExactCliAppFingerprints_ChannelUserTypeThroughTupleDictionaryAndAsyncIterator_VerifyAndRun() {
        let source = `package Oahu.Cli.App.Jobs

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

class JobUpdate {
    var Value int32 = 0
}

class JobScheduler {
    private let subscribers ConcurrentDictionary[Guid, Channel[JobUpdate]] = ConcurrentDictionary[Guid, Channel[JobUpdate]]()

    func ObserveAll() IAsyncEnumerable[JobUpdate] {
        let (ch, key) = RegisterSubscriber()
        return Drain(ch, key)
    }

    func ObserveAsync() IAsyncEnumerable[JobUpdate] {
        let (ch, key) = RegisterSubscriber()
        return Drain(ch, key)
    }

    private func RegisterSubscriber() (Channel[JobUpdate], Guid) {
        let ch = Channel.CreateUnbounded[JobUpdate]()
        let key = Guid.NewGuid()
        subscribers.TryAdd(key, ch)
        return (ch, key)
    }

    private async func Drain(ch Channel[JobUpdate], key Guid) IAsyncEnumerable[JobUpdate] {
        try {
            await for update in ch.Reader.ReadAllAsync() {
                yield update
            }
        } finally {
            subscribers.TryRemove(key, out _)
        }
    }

    async func Run() int32 {
        let (ch, key) = RegisterSubscriber()
        let stream = Drain(ch, key)
        var sum = 0
        let update = JobUpdate()
        update.Value = 7
        ch.Writer.TryWrite(update)
        ch.Writer.Complete()
        await for update in stream {
            sum += update.Value
        }
        return sum
    }
}

Console.WriteLine(JobScheduler().Run().GetAwaiter().GetResult())`
        Assert.Equal(
            "7${Environment.NewLine}",
            CompileVerifyAndRun(source, string.Join(", ", ExactFingerprintPrefixes))
        )
    }

    @Fact
    func MismatchedChannelTypeArgument_StillDiagnoses() {
        let diagnostics = CompileForDiagnostics(`package P
import System
import System.Threading.Channels

class B {}

func Wrong() {
    let channel Channel[B] = Channel.CreateBounded[int32](BoundedChannelOptions(2))
}`)
        Assert.Contains("GS0155", diagnostics, StringComparison.Ordinal)
    }

    shared {
        private let ExactFingerprintPrefixes[]string = []string{"0a1d04691fa4", "1ea76fca833c", "1e6c6a1a86da"}

        private func CompileVerifyAndRun(source string, fingerprintContext string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2702_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
                    let Reference = func (name string) string {
                        return "/reference:" + Path.Combine(runtimeDirectory, name)
                    }
                    exitCode = Program.Main(
                        []string{
                            "/out:" + outputPath,
                            "/target:exe",
                            "/targetframework:net10.0",
                            "/nowarn:GS9100",
                            Reference("System.Private.CoreLib.dll"),
                            Reference("System.Runtime.dll"),
                            Reference("System.Console.dll"),
                            Reference("System.Collections.dll"),
                            Reference("System.Collections.Concurrent.dll"),
                            Reference("System.Threading.dll"),
                            Reference("System.Threading.Channels.dll"),
                            Reference("System.Threading.Tasks.dll"),
                            sourcePath
                        }
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `):
` + "$stdout" + `
` + "$stderr"))
                try {
                    IlVerifier.Verify(outputPath)
                } catch (ex XunitException) {
                    throw XunitException((`Exact issue fingerprints must fall from 3 to 0 (` + "$fingerprintContext" + `).
` + "${ex.Message}"))
                }
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo)!!
                let output = process.StandardOutput.ReadToEnd()
                let error = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `:
` + "$error"))
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func CompileForDiagnostics(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2702_negative_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                try {
                    let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
                    let exitCode = Program.Main(
                        []string{
                            "/out:" + outputPath,
                            "/target:library",
                            "/targetframework:net10.0",
                            "/reference:" + Path.Combine(runtimeDirectory, "System.Private.CoreLib.dll"),
                            "/reference:" + Path.Combine(runtimeDirectory, "System.Runtime.dll"),
                            "/reference:" + Path.Combine(runtimeDirectory, "System.Threading.Channels.dll"),
                            sourcePath
                        }
                    )
                    Assert.NotEqual(0, exitCode)
                    return stdout.ToString() + stderr.ToString()
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }
    }
}
