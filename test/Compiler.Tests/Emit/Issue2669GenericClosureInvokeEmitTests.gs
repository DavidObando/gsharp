// <copyright file="Issue2669GenericClosureInvokeEmitTests.cs" company="GSharp">
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
import Xunit

/// Issue #2669: capture-field accesses in a reified generic closure's
/// `Invoke` must use the constructed display-class TypeSpec even when the
/// field itself has a non-generic type.
open class Issue2669GenericClosureInvokeEmitTests {
    @Fact
    func AppInteractionCallbackMac_ExactGenericClosure_RunsAndVerifies() {
        const Source = `package App
import System
import System.Threading.Tasks

open class InteractionMessage {
    init() {}
}

class InfoMessage : InteractionMessage {
    init() : base() {}
}

class UiDispatcher {
    shared {
        func InvokeAsync(action () -> void) Task {
            action()
            return Task.CompletedTask
        }
    }
}

class InteractionCallbackMac[T InteractionMessage] {
    init() {}

    func Interact(value T) bool? {
        var result bool? = nil
        UiDispatcher.InvokeAsync(() -> {
            result = ShowDialog(value)
        }).Wait()
        return result
    }

    private func ShowDialog(message InteractionMessage) bool? -> true
}

func Main() {
    let callback = InteractionCallbackMac[InfoMessage]()
    Console.WriteLine(callback.Interact(InfoMessage()))
}`
        Assert.Equal(
            "True${Environment.NewLine}",
            CompileAndRun(Source, "AppInteractionCallbackMac_ExactGenericClosure_RunsAndVerifies")
        )
    }

    @Theory
    @InlineData("int32", "42", "42\n")
    @InlineData("string", "\"value\"", "value\n")
    func GenericMethod_NonGenericCaptureField_UsesConstructedClosure(type string, value string, expected string) {
        let source = (`package Generic2669
import System

func Invoke(action () -> void) {
    action()
}

func Run[T](value T) {
    var invoked = false
    Invoke(() -> {
        Console.WriteLine(value)
        invoked = true
    })
    Console.WriteLine(invoked)
}

func Main() {
    Run[` + "$type" + `](` + "$value" + `)
}`)
        Assert.Equal(
            expected + "True${Environment.NewLine}",
            CompileAndRun(source, "GenericMethod_NonGenericCaptureField_UsesConstructedClosure" + type)
        )
    }

    @Fact
    func GenericClosure_IncompatibleCapturedArgument_RemainsRejected() {
        let syntax = SyntaxTree.Parse(SourceText.From(`package Negative2669

open class InteractionMessage {}
class InfoMessage : InteractionMessage {}
class ErrorMessage : InteractionMessage {}

class InteractionCallbackMac[T InteractionMessage] {
    func Interact(value T) {
        let callback = () -> {
            ShowDialog(value)
        }
        callback()
    }

    private func ShowDialog(message ErrorMessage) {}
}`))
        let compilation = Compilation(syntax)
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2669.Negative")
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0154")
    }

    shared {
        private func CompileAndRun(source string, caseName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2669Emit", caseName)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.True(exitCode == 0, (`gsc failed:
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            IlVerifier.Verify(assemblyPath)
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
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
