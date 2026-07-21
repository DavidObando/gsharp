// <copyright file="Issue2669GenericClosureInvokeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2669: capture-field accesses in a reified generic closure's
/// <c>Invoke</c> must use the constructed display-class TypeSpec even when the
/// field itself has a non-generic type.
/// </summary>
public class Issue2669GenericClosureInvokeEmitTests
{
    [Fact]
    public void AppInteractionCallbackMac_ExactGenericClosure_RunsAndVerifies()
    {
        const string Source = """
            package App
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
            }
            """;

        Assert.Equal("True\n", CompileAndRun(Source, nameof(AppInteractionCallbackMac_ExactGenericClosure_RunsAndVerifies)));
    }

    [Theory]
    [InlineData("int32", "42", "42\n")]
    [InlineData("string", "\"value\"", "value\n")]
    public void GenericMethod_NonGenericCaptureField_UsesConstructedClosure(
        string type,
        string value,
        string expected)
    {
        var source = $$"""
            package Generic2669
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
                Run[{{type}}]({{value}})
            }
            """;

        Assert.Equal(
            expected + "True\n",
            CompileAndRun(source, nameof(GenericMethod_NonGenericCaptureField_UsesConstructedClosure) + type));
    }

    [Fact]
    public void GenericClosure_IncompatibleCapturedArgument_RemainsRejected()
    {
        var syntax = SyntaxTree.Parse(SourceText.From(
            """
            package Negative2669

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
            }
            """));
        var compilation = new Compilation(syntax);

        using var output = new MemoryStream();
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2669.Negative");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0155");
    }

    private static string CompileAndRun(string source, string caseName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2669Emit", caseName);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.True(exitCode == 0, $"gsc failed:\n{stdout}\n{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        IlVerifier.Verify(assemblyPath);

        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(process.ExitCode == 0, error);
        return output.Replace("\r\n", "\n");
    }
}
