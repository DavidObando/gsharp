// <copyright file="Issue2984MainEntryPointInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Execution;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2984: script-mode execution invokes the entry point selected by the
/// binder. Historically pinned on the tree-walking evaluator (including the
/// direct <c>Evaluator</c>-constructor overload surface); since the evaluator
/// retired in ADR-0156 Phase 3c (#3176) the same observable entry-point
/// selection runs through <see cref="EmittedProgramHost"/> — the gsi script
/// driver — with the assertions preserved.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2984MainEntryPointInterpreterTests
{
    [Fact]
    public void PackageScopeMainRuns()
    {
        const string Source = """
            import System

            func Main() {
                Console.WriteLine("package-main")
            }
            """;

        var (diagnostics, output) = Run(Source);

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal($"package-main{Environment.NewLine}", output);
    }

    [Fact]
    public void ValueEchoPreservesTopLevelExpressionValue()
    {
        // The evaluator's `Evaluate` value-echo contract, preserved through
        // the emitted oracle's synthesized trailing-expression capture.
        var result = EmittedOracle.Evaluate("40 + 2");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ClassScopedSharedMainRuns()
    {
        const string Source = """
            import System

            class Launcher {
                shared {
                    func Main() {
                        Console.WriteLine("class-main")
                    }
                }
            }
            """;

        var (diagnostics, output) = Run(Source);

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal($"class-main{Environment.NewLine}", output);
    }

    [Fact]
    public void TopLevelStatementsStillRun()
    {
        const string Source = """
            import System

            Console.WriteLine("top-level")
            """;

        var (diagnostics, output) = Run(Source);

        Assert.Empty(diagnostics);
        Assert.Equal($"top-level{Environment.NewLine}", output);
    }

    [Fact]
    public void TopLevelStatementsWinOverExplicitMain()
    {
        const string Source = """
            import System

            Console.WriteLine("top-level")

            func Main() {
                Console.WriteLine("explicit-main")
            }
            """;

        var (diagnostics, output) = Run(Source);

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0166");
        Assert.Equal($"top-level{Environment.NewLine}", output);
    }

    [Fact]
    public void MainArgsReceivesEmptyArray()
    {
        const string Source = """
            import System

            func Main(args []string) {
                Console.WriteLine(args.Length)
            }
            """;

        var (diagnostics, output) = Run(Source);

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal($"0{Environment.NewLine}", output);
    }

    [Fact]
    public void NonArgsMainParameterIsNotSeededWithStringArray()
    {
        const string Source = """
            import System

            func Main(x int32) {
                Console.WriteLine(x)
            }
            """;

        var (diagnostics, output) = Run(Source);

        // A `Main` whose parameter is not `args []string` is not an entry
        // point: nothing is seeded (no System.String[] coercion — the
        // original #2984 bug) and nothing runs. The evaluator additionally
        // reported an invocation error naming the parameter; the emitted
        // driver simply produces a program without an entry point.
        Assert.DoesNotContain(
            diagnostics,
            diagnostic => diagnostic.Message.Contains("System.String[]"));
        Assert.Equal(string.Empty, output);
    }

    private static (ImmutableArray<Diagnostic> Diagnostics, string Output) Run(string source)
    {
        using var output = new StringWriter();
        var previousOutput = Console.Out;
        Console.SetOut(output);
        try
        {
            var compilation = new Compilation(SyntaxTree.Parse(source));
            var result = EmittedProgramHost.Run(compilation);
            return (result.Diagnostics, output.ToString().ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            Console.SetOut(previousOutput);
        }
    }
}
