// <copyright file="Issue2984MainEntryPointInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2984: the interpreter invokes the entry point selected by the binder.
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

        var (result, output) = Evaluate(Source);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal("package-main\n", output);
    }

    [Fact]
    public void EvaluatorDefaultRunsEntryPoint()
    {
        const string Source = """
            import System

            func Main() {
                Console.WriteLine("evaluator-main")
            }
            """;

        using var output = new StringWriter();
        var previousOutput = Console.Out;
        Console.SetOut(output);
        try
        {
            var compilation = new Compilation(SyntaxTree.Parse(Source));
            var evaluator = new Evaluator(
                compilation.BoundProgram,
                new Dictionary<VariableSymbol, object>());

            evaluator.Evaluate();

            Assert.Equal("evaluator-main\n", output.ToString().Replace("\r\n", "\n"));
        }
        finally
        {
            Console.SetOut(previousOutput);
        }
    }

    [Fact]
    public void CompilationEvaluationPreservesTopLevelExpressionValue()
    {
        var result = new Compilation(SyntaxTree.Parse("40 + 2"))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void EvaluatorDefaultPreservesTopLevelExpressionValue()
    {
        var compilation = new Compilation(SyntaxTree.Parse("40 + 2"));
        var evaluator = new Evaluator(
            compilation.BoundProgram,
            new Dictionary<VariableSymbol, object>());

        Assert.Equal(42, evaluator.Evaluate());
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

        var (result, output) = Evaluate(Source);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal("class-main\n", output);
    }

    [Fact]
    public void TopLevelStatementsStillRun()
    {
        const string Source = """
            import System

            Console.WriteLine("top-level")
            """;

        var (result, output) = Evaluate(Source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("top-level\n", output);
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

        var (result, output) = Evaluate(Source);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0166");
        Assert.Equal("top-level\n", output);
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

        var (result, output) = Evaluate(Source);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal("0\n", output);
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

        var (result, output) = Evaluate(Source);

        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.IsError && diagnostic.Message.Contains("x int32"));
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Message.Contains("System.String[]"));
        Assert.Equal(string.Empty, output);
    }

    private static (EvaluationResult Result, string Output) Evaluate(string source)
    {
        using var output = new StringWriter();
        var previousOutput = Console.Out;
        Console.SetOut(output);
        try
        {
            var result = new Compilation(SyntaxTree.Parse(source))
                .Evaluate(new Dictionary<VariableSymbol, object>());
            return (result, output.ToString().Replace("\r\n", "\n"));
        }
        finally
        {
            Console.SetOut(previousOutput);
        }
    }
}
