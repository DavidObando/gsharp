// <copyright file="Issue3130GsiReferenceOptionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3130 / ADR-0156 Phase 1: <c>gsi</c> gains gsc's <c>/r:</c> reference
/// channel in script mode, and the referenced assembly resolves both at
/// compile time (the import binds) and at runtime (the emitted program's load
/// context loads it from the supplied path). The library is compiled by gsc
/// into a scratch directory so it is invisible to the test host's own probing
/// paths — the negative case below proves the reference channel is the only
/// thing making the positive cases pass.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3130GsiReferenceOptionTests
{
    // Each test uses its own package name: an assembly loaded (even into an
    // unloaded, collectible context) by one test must not be able to satisfy
    // another test's import through the in-process resolver's view of loaded
    // assemblies.
    private const string LibrarySourceTemplate = """
        package {0}

        import System

        class Doubler(Factor int32) {{
            func Apply(value int32) int32 {{
                return value * Factor
            }}
        }}
        """;

    private const string ScriptSourceTemplate = """
        import System
        import {0}

        Console.WriteLine(Doubler(2).Apply(21))
        """;

    [Fact]
    public void ReferenceOption_LoadsAssemblyForCompileAndRun()
    {
        const string PackageName = "Widgets3130A";
        var directory = CreateTestDirectory(nameof(ReferenceOption_LoadsAssemblyForCompileAndRun));
        var libraryPath = CompileLibrary(directory, PackageName);

        var result = RunGsi(directory, PackageName, "/r:" + libraryPath);

        Assert.Equal(string.Empty, result.StandardError);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"42{Environment.NewLine}", result.StandardOutput);
    }

    [Fact]
    public void ReferenceKeywordAlias_IsAccepted()
    {
        const string PackageName = "Widgets3130B";
        var directory = CreateTestDirectory(nameof(ReferenceKeywordAlias_IsAccepted));
        var libraryPath = CompileLibrary(directory, PackageName);

        var result = RunGsi(directory, PackageName, "/reference:" + libraryPath);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"42{Environment.NewLine}", result.StandardOutput);
    }

    [Fact]
    public void WithoutReference_TheImportFailsToBind()
    {
        // Discriminating witness for the reference channel: the identical
        // script must fail without /r:, so the passing cases above cannot be
        // passing for a reason other than the supplied reference.
        const string PackageName = "Widgets3130C";
        var directory = CreateTestDirectory(nameof(WithoutReference_TheImportFailsToBind));
        CompileLibrary(directory, PackageName);

        var result = RunGsi(directory, PackageName);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardOutput);
        Assert.Contains("error GS0130: Function 'Doubler' doesn't exist.", result.StandardError, StringComparison.Ordinal);
    }

    private static string CreateTestDirectory(string name)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue3130GsiReferenceOptionTests), name);
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static string CompileLibrary(string directory, string packageName)
    {
        var librarySourcePath = Path.Combine(directory, "widgets.gs");
        var libraryPath = Path.Combine(directory, packageName + ".dll");
        File.WriteAllText(librarySourcePath, string.Format(LibrarySourceTemplate, packageName));

        var (exitCode, stdout, stderr) = Capture(() => GSharp.Compiler.Program.Main(new[]
        {
            "/target:library",
            "/out:" + libraryPath,
            librarySourcePath,
        }));
        Assert.True(exitCode == 0, $"library compile failed: {stdout}{stderr}");
        Assert.True(File.Exists(libraryPath));
        return libraryPath;
    }

    private static (int ExitCode, string StandardOutput, string StandardError) RunGsi(
        string directory,
        string packageName,
        params string[] additionalArguments)
    {
        var sourcePath = Path.Combine(directory, "script.gs");
        File.WriteAllText(sourcePath, string.Format(ScriptSourceTemplate, packageName));

        var arguments = new string[additionalArguments.Length + 1];
        additionalArguments.CopyTo(arguments, 0);
        arguments[^1] = sourcePath;
        return Capture(() => GSharp.Repl.Program.Main(arguments));
    }

    private static (int ExitCode, string StandardOutput, string StandardError) Capture(Func<int> action)
    {
        using var stdout = new StringWriter { NewLine = Environment.NewLine };
        using var stderr = new StringWriter { NewLine = Environment.NewLine };
        var previousOut = Console.Out;
        var previousError = Console.Error;
        int exitCode;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            exitCode = action();
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return (
            exitCode,
            stdout.ToString().ReplaceLineEndings(Environment.NewLine),
            stderr.ToString().ReplaceLineEndings(Environment.NewLine));
    }
}
