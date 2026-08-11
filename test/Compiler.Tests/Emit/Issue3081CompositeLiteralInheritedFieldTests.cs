// <copyright file="Issue3081CompositeLiteralInheritedFieldTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using GSharp.Tests;
using Xunit;
using CompilerProgram = GSharp.Compiler.Program;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3081: composite literals preserve inherited field declaring types.
/// </summary>
public class Issue3081CompositeLiteralInheritedFieldTests
{
    [Fact]
    public void CompositeLiteralFieldMatrix_GscEvaluateAndEmit()
    {
        AssertCompilerDrivers(
            "TopLevel",
            Issue3081CompositeLiteralCases.BuildMatrixSource(inFunction: false),
            Issue3081CompositeLiteralCases.BuildMatrixOutput(100));
        AssertCompilerDrivers(
            "InFunction",
            Issue3081CompositeLiteralCases.BuildMatrixSource(inFunction: true),
            Issue3081CompositeLiteralCases.BuildMatrixOutput(200));
    }

    [Fact]
    public void CompositeLiteralFalsePositiveCorpus_GscEvaluateAndEmit()
    {
        AssertCompilerDrivers(
            "Controls",
            Issue3081CompositeLiteralCases.Controls,
            Issue3081CompositeLiteralCases.ControlsOutput);
    }

    [Fact]
    public void ObjectInitializerInheritedGenericBaseField_GscEvaluateAndEmit()
    {
        AssertCompilerDrivers(
            "ObjectInitializer",
            Issue3081CompositeLiteralCases.ObjectInitializer,
            Issue3081CompositeLiteralCases.ObjectInitializerOutput);
    }

    [Fact]
    public void CompositeLiteralLowering_PreservesInheritedFieldDeclaringType()
    {
        AssertCompilerDrivers(
            "Lowering",
            Issue3081CompositeLiteralCases.Lowering,
            Issue3081CompositeLiteralCases.LoweringOutput);
    }

    [Fact]
    public void CompositeLiteralAsyncSpill_PreservesInheritedFieldDeclaringType()
    {
        AssertCompilerDrivers(
            "AsyncSpill",
            Issue3081CompositeLiteralCases.AsyncSpill,
            Issue3081CompositeLiteralCases.AsyncSpillOutput);
    }

    private static void AssertCompilerDrivers(string name, string source, string expected)
    {
        AssertBareCompiler(name, source, expected);
        AssertEmittedCompiler(name, source, expected);
    }

    private static void AssertBareCompiler(string name, string source, string expected)
    {
        var result = InEmptyDirectory(name + "-gsc", directory =>
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            File.WriteAllText(sourcePath, source);
            return CaptureConsole(() => CompilerProgram.Main(new[] { "/nowarn:GS9100", sourcePath }));
        });

        Assert.True(result.ExitCode == 0, $"{name} gsc failed:\n{result.Stdout}\n{result.Stderr}");
        Assert.Equal(expected + $"Success.{Environment.NewLine}", result.Stdout);
        Assert.Equal(string.Empty, result.Stderr);
    }

    private static void AssertEmittedCompiler(string name, string source, string expected)
    {
        InEmptyDirectory(name + "-emit", directory =>
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "program.dll");
            File.WriteAllText(sourcePath, source);
            var compile = CaptureConsole(() => CompilerProgram.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                sourcePath,
            }));

            Assert.True(compile.ExitCode == 0, $"{name} emit failed:\n{compile.Stdout}\n{compile.Stderr}");
            Assert.Equal(string.Empty, compile.Stderr);
            var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
            Assert.NotEmpty(assembly.GetTypes());

            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList = { assemblyPath },
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            Assert.NotNull(process);
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            var exited = process.WaitForExit(30_000);
            if (!exited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit();
            }

            var stdout = Normalize(stdoutTask.GetAwaiter().GetResult());
            var stderr = Normalize(stderrTask.GetAwaiter().GetResult());
            Assert.True(exited, $"{name} emitted program timed out.");
            Assert.True(process.ExitCode == 0, $"{name} emitted program exited {process.ExitCode}:\n{stdout}\n{stderr}");
            Assert.Equal(expected, stdout);
            Assert.Equal(string.Empty, stderr);
            IlVerifier.Verify(assemblyPath);
            return 0;
        });
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
