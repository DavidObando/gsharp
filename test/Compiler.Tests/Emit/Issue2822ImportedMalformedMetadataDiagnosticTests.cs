// <copyright file="Issue2822ImportedMalformedMetadataDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2822: malformed imported enumerator metadata reports GS0501.</summary>
public sealed class Issue2822ImportedMalformedMetadataDiagnosticTests
{
    [Fact]
    public void ImportedReturnTypeOnlyGetEnumeratorPair_ReportsStructuredDiagnostic()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2822-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        try
        {
            var librarySourcePath = Path.Combine(directory, "library.gs");
            var libraryPath = Path.Combine(directory, "Issue2822.Library.dll");
            File.WriteAllText(librarySourcePath, """
                package Issue2822.Library
                import System.Collections
                import System.Collections.Generic

                class Broken : IEnumerable[int32] {
                    func GetEnumerator() IEnumerator[int32] -> List[int32]().GetEnumerator()
                    func GetEnumerator() IEnumerator -> GetEnumerator()
                }
                """);

            var libraryResult = RunCompiler(new[]
            {
                "/out:" + libraryPath,
                "/target:library",
                "/targetframework:net10.0",
                librarySourcePath,
            });
            Assert.True(
                libraryResult.ExitCode == 0,
                $"library compile failed\n{libraryResult.Stdout}\n{libraryResult.Stderr}");

            var consumerSourcePath = Path.Combine(directory, "consumer.gs");
            var consumerPath = Path.Combine(directory, "Issue2822.Consumer.dll");
            File.WriteAllText(consumerSourcePath, """
                package Issue2822.Consumer
                import Issue2822.Library

                func Consume(value Broken) {
                    for item in value {}
                }
                """);

            var consumerResult = RunCompiler(new[]
            {
                "/out:" + consumerPath,
                "/target:library",
                "/targetframework:net10.0",
                "/reference:" + libraryPath,
                consumerSourcePath,
            });
            var output = consumerResult.Stdout + consumerResult.Stderr;

            Assert.NotEqual(0, consumerResult.ExitCode);
            Assert.Contains("consumer.gs(5,", output, StringComparison.Ordinal);
            Assert.Contains("GS0501", output, StringComparison.Ordinal);
            Assert.Contains("Broken", output, StringComparison.Ordinal);
            Assert.Contains("GetEnumerator", output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal);
            Assert.DoesNotContain("AmbiguousMatchException", output, StringComparison.Ordinal);
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

    private static (int ExitCode, string Stdout, string Stderr) RunCompiler(string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args), stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }
}
