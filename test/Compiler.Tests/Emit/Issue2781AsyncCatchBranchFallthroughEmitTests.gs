// <copyright file="Issue2781AsyncCatchBranchFallthroughEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2781: mutually exclusive catch branches must remain exclusive after
/// awaited handlers are lifted into an async state machine.
open class Issue2781AsyncCatchBranchFallthroughEmitTests {
    @Fact
    func AwaitedCatchBranches_PreserveFilteringRethrowFinallyAndControls() {
        const Source = `package Issue2781
import System
import System.Threading.Tasks

async func Step() ValueTask { await Task.Delay(1) }

async func Filtered(mode int32) string {
    var result = "unset"
    try {
        await Task.Yield()
        if mode == 0 { throw OperationCanceledException("cancel") }
        if mode == 1 { throw InvalidOperationException("general") }
        if mode == 2 { throw OperationCanceledException("other-cancel") }
        throw ArgumentException("rethrow")
    } catch (__caught Exception) {
        if __caught is OperationCanceledException {
            let cancel = __caught
            if mode == 0 {
                result = "canceled"
                await Step().ConfigureAwait(false)
            } else {
                if cancel is Exception {
                    let ex = cancel
                    result = "failed-inner:" + ex.Message
                    await Step().ConfigureAwait(false)
                } else { throw cancel }
            }
        } else {
            if __caught is InvalidOperationException {
                let ex = __caught
                result = "failed-outer:" + ex.Message
                await Step().ConfigureAwait(false)
            } else { throw __caught }
        }
    } finally {
        Console.WriteLine("finally:${mode}")
    }
    return result
}

async func Typed(mode int32) string {
    try {
        await Task.Yield()
        if mode == 0 { throw OperationCanceledException("cancel") }
        throw InvalidOperationException("general")
    } catch (c OperationCanceledException) {
        await Step()
        return "typed-canceled:" + c.Message
    } catch (e Exception) {
        await Step()
        return "typed-general:" + e.Message
    }
}

func SyncFiltered(mode int32) string {
    var result = "unset"
    try {
        if mode == 0 { throw OperationCanceledException("cancel") }
        throw InvalidOperationException("general")
    } catch (__caught Exception) {
        if __caught is OperationCanceledException {
            let cancel = __caught
            if mode == 0 { result = "sync-canceled" } else {
                if cancel is Exception { result = "sync-inner" } else { throw cancel }
            }
        } else {
            if __caught is InvalidOperationException {
                result = "sync-general"
            } else { throw __caught }
        }
    }
    return result
}

async func NonAwaitedHandler(mode int32) string {
    var result = "unset"
    try {
        await Task.Yield()
        if mode == 0 { throw OperationCanceledException("cancel") }
        throw InvalidOperationException("general")
    } catch (__caught Exception) {
        if __caught is OperationCanceledException {
            let cancel = __caught
            if mode == 0 { result = "plain-canceled" } else {
                if cancel is Exception { result = "plain-inner" } else { throw cancel }
            }
        } else {
            if __caught is InvalidOperationException {
                result = "plain-general"
            } else { throw __caught }
        }
    }
    return result
}

Console.WriteLine(Filtered(0).GetAwaiter().GetResult())
Console.WriteLine(Filtered(1).GetAwaiter().GetResult())
Console.WriteLine(Filtered(2).GetAwaiter().GetResult())
try {
    Console.WriteLine(Filtered(3).GetAwaiter().GetResult())
} catch (e ArgumentException) {
    Console.WriteLine("rethrown:" + e.Message)
}
Console.WriteLine(Typed(0).GetAwaiter().GetResult())
Console.WriteLine(Typed(1).GetAwaiter().GetResult())
Console.WriteLine(SyncFiltered(0))
Console.WriteLine(SyncFiltered(1))
Console.WriteLine(NonAwaitedHandler(0).GetAwaiter().GetResult())
Console.WriteLine(NonAwaitedHandler(1).GetAwaiter().GetResult())`
        Assert.Equal(`finally:0
canceled
finally:1
failed-outer:general
finally:2
failed-inner:other-cancel
finally:3
rethrown:rethrow
typed-canceled:cancel
typed-general:general
sync-canceled
sync-general
plain-canceled
plain-general
`.ReplaceLineEndings(Environment.NewLine), CompileVerifyAndRun(Source))
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2781Emit")
            Directory.CreateDirectory(directory)
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
                let exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `):
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            IlVerifier.Verify(outputPath)
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                        outputPath
                    },
                    WorkingDirectory = directory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            let output = process!!.StandardOutput.ReadToEnd()
            let error = process!!.StandardError.ReadToEnd()
            Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(process!!.ExitCode == 0, error)
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
