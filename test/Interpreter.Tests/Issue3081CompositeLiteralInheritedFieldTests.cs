// <copyright file="Issue3081CompositeLiteralInheritedFieldTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Tests;
using Xunit;
using ReplProgram = GSharp.Repl.Program;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3081: Emitted-execution coverage for composite literal inherited field.
/// </summary>
public class Issue3081CompositeLiteralInheritedFieldTests
{
    [Fact]
    public void CompositeLiteralFieldMatrix_Gsi()
    {
        AssertGsi(
            "TopLevel",
            Issue3081CompositeLiteralCases.BuildMatrixSource(inFunction: false),
            Issue3081CompositeLiteralCases.BuildMatrixOutput(100));
        AssertGsi(
            "InFunction",
            Issue3081CompositeLiteralCases.BuildMatrixSource(inFunction: true),
            Issue3081CompositeLiteralCases.BuildMatrixOutput(200));
    }

    [Fact]
    public void CompositeLiteralFalsePositiveCorpus_Gsi()
        => AssertGsi(
            "Controls",
            Issue3081CompositeLiteralCases.Controls,
            Issue3081CompositeLiteralCases.ControlsOutput);

    [Fact]
    public void ObjectInitializerInheritedGenericBaseField_Gsi()
        => AssertGsi(
            "ObjectInitializer",
            Issue3081CompositeLiteralCases.ObjectInitializer,
            Issue3081CompositeLiteralCases.ObjectInitializerOutput);

    [Fact]
    public void CompositeLiteralLowering_Gsi()
        => AssertGsi(
            "Lowering",
            Issue3081CompositeLiteralCases.Lowering,
            Issue3081CompositeLiteralCases.LoweringOutput);

    [Fact]
    public void CompositeLiteralAsyncSpill_Gsi()
        => AssertGsi(
            "AsyncSpill",
            Issue3081CompositeLiteralCases.AsyncSpill,
            Issue3081CompositeLiteralCases.AsyncSpillOutput);

    private static void AssertGsi(string name, string source, string expected)
    {
        var result = InEmptyDirectory(name, directory =>
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            File.WriteAllText(sourcePath, source);
            return CaptureConsole(() => ReplProgram.Main(new[] { sourcePath }));
        });

        Assert.True(result.ExitCode == 0, $"{name} gsi failed:\n{result.Stdout}\n{result.Stderr}");
        Assert.Equal(expected, result.Stdout);
        Assert.Equal(string.Empty, result.Stderr);
    }

    private static DriverResult CaptureConsole(Func<int> action)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return new DriverResult(action(), Normalize(stdout.ToString()), Normalize(stderr.ToString()));
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static T InEmptyDirectory<T>(string name, Func<string, T> action)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3081CompositeLiteralInheritedFieldTests),
            name + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory));
        try
        {
            return action(directory);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    private static string Normalize(string text) => text.ReplaceLineEndings(Environment.NewLine);

    private readonly record struct DriverResult(int ExitCode, string Stdout, string Stderr);
}
