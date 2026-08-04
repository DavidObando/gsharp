// <copyright file="Issue2988DeinitInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Interpreter boundary coverage for CLR GC finalizers declared with <c>deinit</c>.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2988DeinitInterpreterTests
{
    [Fact]
    public void DeinitializersWarnOncePerDeclaringClassWithoutRunning()
    {
        var source = """
            import System

            class First {
                deinit {
                    Console.WriteLine("deinit-11")
                }

                func Touch() {
                }
            }

            class Second {
                deinit {
                    Console.WriteLine("deinit-22")
                }
            }

            var first = First()
            var second = Second()
            Console.WriteLine("body-33")
            GC.KeepAlive(first)
            GC.KeepAlive(second)
            """;

        var engine = new SessionEngine { CaptureConsole = true };
        var cell = engine.Evaluate(source);

        Assert.False(cell.HasError);
        Assert.Equal("body-33\n", cell.Output);
        var warnings = cell.Diagnostics
            .Where(diagnostic => diagnostic.Id == "GS0510")
            .OrderBy(diagnostic => diagnostic.Message)
            .ToArray();
        Assert.Collection(
            warnings,
            warning => AssertWarning(warning, "First"),
            warning => AssertWarning(warning, "Second"));

        var next = engine.Evaluate("""Console.WriteLine("next-44")""");
        Assert.Equal("next-44\n", next.Output);
        Assert.DoesNotContain(next.Diagnostics, diagnostic => diagnostic.Id == "GS0510");
    }

    [Theory]
    [InlineData(Issue3010EntryPointDriverMatrixTests.Driver.CompilerEvaluation)]
    [InlineData(Issue3010EntryPointDriverMatrixTests.Driver.CompilerEmission)]
    [InlineData(Issue3010EntryPointDriverMatrixTests.Driver.Interpreter)]
    public void InheritedDeinitializersExposeDriverBoundaryPerDeclaringClass(
        Issue3010EntryPointDriverMatrixTests.Driver driver)
    {
        const string Source = """
            import System

            open class Resource(Tag string) {
                deinit {
                    Console.WriteLine("base-deinit-11")
                }
            }

            class CachedResource : Resource {
                init(tag string) : base(tag) {
                }

                deinit {
                    Console.WriteLine("derived-deinit-22")
                }
            }

            func Allocate() {
                var resource = CachedResource("held-33")
                Console.WriteLine("body-44")
                GC.KeepAlive(resource)
            }

            Allocate()
            GC.Collect()
            GC.WaitForPendingFinalizers()
            Console.WriteLine("end-55")
            """;
        const string InterpretedOutput = "body-44\nend-55\n";
        const string EmittedOutput = "body-44\nderived-deinit-22\nbase-deinit-11\nend-55\n";

        var result = Issue3010EntryPointDriverMatrixTests.Run(
            "inherited-deinit-" + driver,
            Source,
            driver);
        Assert.Equal(0, result.ExitCode);

        string warningOutput;
        switch (driver)
        {
            case Issue3010EntryPointDriverMatrixTests.Driver.CompilerEvaluation:
                Assert.StartsWith(InterpretedOutput + "\n", result.StandardOutput, StringComparison.Ordinal);
                Assert.EndsWith("Success.\n", result.StandardOutput, StringComparison.Ordinal);
                Assert.Equal(string.Empty, result.StandardError);
                warningOutput = result.StandardOutput[InterpretedOutput.Length..];
                break;
            case Issue3010EntryPointDriverMatrixTests.Driver.CompilerEmission:
                Assert.Equal(EmittedOutput, result.StandardOutput);
                Assert.Equal(string.Empty, result.StandardError);
                return;
            case Issue3010EntryPointDriverMatrixTests.Driver.Interpreter:
                Assert.Equal(InterpretedOutput, result.StandardOutput);
                warningOutput = result.StandardError;
                break;
            default:
                throw new InvalidOperationException($"Unexpected driver {driver}.");
        }

        Assert.Equal(
            2,
            warningOutput.Split('\n')
                .Count(line => line.Contains("warning GS0510", StringComparison.Ordinal)));
        Assert.Contains("class 'CachedResource'", warningOutput, StringComparison.Ordinal);
        Assert.Contains("class 'Resource'", warningOutput, StringComparison.Ordinal);
    }

    [Fact]
    public void EscapingInstanceIsNotFinalizedAtScopeExitOrWhileReachable()
    {
        var source = """
            import System

            class Res(Tag string) {
                deinit {
                    Console.WriteLine("deinit-11: " + Tag)
                }
            }

            func Make() Res {
                var r = Res("kept")
                Console.WriteLine("made-22")
                return r
            }

            var held = Make()
            GC.Collect()
            GC.WaitForPendingFinalizers()
            Console.WriteLine("after-collect-33")
            Console.WriteLine(held.Tag)
            """;

        var cell = new SessionEngine { CaptureConsole = true }.Evaluate(source);

        Assert.False(cell.HasError);
        Assert.Equal("made-22\nafter-collect-33\nkept\n", cell.Output);
        var warning = Assert.Single(cell.Diagnostics, diagnostic => diagnostic.Id == "GS0510");
        AssertWarning(warning, "Res");
    }

    [Fact]
    public void CompilationErrorsSuppressDeinitializerBoundaryWarning()
    {
        var source = """
            class Resource {
                deinit {
                }
            }

            var broken =
            """;

        var cell = new SessionEngine().Evaluate(source);

        Assert.True(cell.HasError);
        Assert.DoesNotContain(cell.Diagnostics, diagnostic => diagnostic.Id == "GS0510");
    }

    [Fact]
    public void ScriptRunnerUsesRichRendererForBoundaryWarning()
    {
        var sourcePath = Path.Combine(AppContext.BaseDirectory, "issue2988-deinit.gs");
        File.WriteAllText(
            sourcePath,
            """
            class Resource {
                deinit {
                }
            }

            Console.WriteLine("body-33")
            """);

        var previousOut = Console.Out;
        var previousError = Console.Error;
        using var output = new StringWriter { NewLine = "\n" };
        using var error = new StringWriter { NewLine = "\n" };
        Console.SetOut(output);
        Console.SetError(error);
        try
        {
            var exitCode = GSharp.Repl.Program.Main([sourcePath]);

            // Unlike GS0513, GS0510 skips only a GC-scheduled side effect after evaluation completes.
            Assert.Equal(0, exitCode);
            Assert.Equal("body-33\n", output.ToString());
            Assert.Contains("warning GS0510", error.ToString(), StringComparison.Ordinal);
            Assert.Contains("deinit", error.ToString(), StringComparison.Ordinal);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
            File.Delete(sourcePath);
        }
    }

    private static void AssertWarning(Diagnostic warning, string className)
    {
        Assert.Equal(DiagnosticSeverity.Warning, warning.Severity);
        Assert.Contains($"class '{className}'", warning.Message, StringComparison.Ordinal);
        Assert.Contains("will not run under the interpreter", warning.Message, StringComparison.Ordinal);
        Assert.NotNull(warning.Location.Text);
        Assert.Equal("deinit", warning.Location.Text.ToString(warning.Location.Span));
    }
}
