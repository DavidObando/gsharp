// <copyright file="Issue2727AsyncLambdaFieldWriteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #2727: field writes through a captured `this` in an async lambda
/// must be redirected through both the closure and async state-machine receivers.
open class Issue2727AsyncLambdaFieldWriteEmitTests {
    @Fact
    func ExactQueueScreenLoadAsync_PostAwaitFieldWrites_VerifyAndRun() {
        const Source = `package Oahu.Cli.Tui.Screens

import System
import System.Threading.Tasks

class QueueScreen() {
    private var entries int32
    private var cursor int32
    private var statusMessage string? = nil

    prop Result string -> "${entries}:${cursor}:${statusMessage ?? "ok"}"

    func LoadAsync() Task {
        return Task.Run(async () -> {
            try {
                await Task.Yield()
                entries = 42
                cursor = 2
            } catch (ex Exception) {
                statusMessage = "Failed to load queue: ${ex.Message}"
                entries = 0
            }
        })
    }
}

let screen = QueueScreen()
screen.LoadAsync().GetAwaiter().GetResult()
Console.WriteLine(screen.Result)`
        Assert.Equal("42:2:ok${Environment.NewLine}", CompileVerifyAndRun(Source, "ExactQueueScreen"))
    }

    @Fact
    func AsyncLambda_FieldWritesBeforeAndAfterAwaitAndInCatch_VerifyAndRun() {
        const Source = `package Issue2727TryCatch

import System
import System.Threading.Tasks

class Worker() {
    private var value int32
    private var caught bool
    prop Result string -> "${value}:${caught}"

    func RunAsync() Task {
        return Task.Run(async () -> {
            this.value = 1
            try {
                await Task.Yield()
                this.value = 2
                throw InvalidOperationException("expected")
            } catch (ex Exception) {
                await Task.Yield()
                this.value = 3
                this.caught = ex.Message == "expected"
            }
        })
    }
}

let worker = Worker()
worker.RunAsync().GetAwaiter().GetResult()
Console.WriteLine(worker.Result)`
        Assert.Equal("3:True${Environment.NewLine}", CompileVerifyAndRun(Source, "PrePostAwaitCatch"))
    }

    @Fact
    func NestedAndEscapingAsyncLambdas_FieldWrites_VerifyAndRun() {
        const Source = `package Issue2727Nested

import System
import System.Threading.Tasks

class Worker() {
    private var value int32
    prop Value int32 -> value

    func RunNestedAsync() Task {
        return Task.Run(async () -> {
            await Task.Yield()
            let assign = () -> { this.value = 4 }
            assign()
        })
    }

    func MakeEscapingAsync() () -> Task {
        return async () -> {
            await Task.Yield()
            this.value = 5
        }
    }
}

let worker = Worker()
worker.RunNestedAsync().GetAwaiter().GetResult()
Console.WriteLine(worker.Value)
let escaped = worker.MakeEscapingAsync()
escaped().GetAwaiter().GetResult()
Console.WriteLine(worker.Value)`
        Assert.Equal("4${Environment.NewLine}5${Environment.NewLine}", CompileVerifyAndRun(Source, "NestedEscaping"))
    }

    @Fact
    func DirectAsyncMethodAndAsyncLambdaPropertySetter_RemainUnchanged() {
        const Source = `package Issue2727Controls

import System
import System.Threading.Tasks

class Worker() {
    private var backing int32
    prop Value int32 {
        get -> backing
        set -> this.backing = value
    }

    async func DirectAsync() {
        this.backing = 6
        await Task.Yield()
        this.backing = 7
    }

    func SetPropertyAsync() Task {
        return Task.Run(async () -> {
            await Task.Yield()
            this.Value = 8
        })
    }
}

let worker = Worker()
worker.DirectAsync().GetAwaiter().GetResult()
Console.WriteLine(worker.Value)
worker.SetPropertyAsync().GetAwaiter().GetResult()
Console.WriteLine(worker.Value)`
        Assert.Equal("7${Environment.NewLine}8${Environment.NewLine}", CompileVerifyAndRun(Source, "DirectControls"))
    }

    @Fact
    func AsyncLambda_ReadOnlyFieldWrite_IsRejectedAtAssignmentWithoutEmitFailure() {
        const Source = `package Issue2727Negative

import System.Threading.Tasks

class Worker() {
    private let entries int32 = 0

    func RunAsync() Task {
        return Task.Run(async () -> {
            await Task.Yield()
            this.entries = 1
        })
    }
}`
        let tree = SyntaxTree.Parse(SourceText.From(Source, "Issue2727Negative.gs"))
        let compilation = Compilation(tree)
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2727.Negative")
        Assert.False(result.Success)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
        Assert.Equal("=", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    shared {
        private func CompileVerifyAndRun(source string, caseName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2727Emit", caseName)
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
