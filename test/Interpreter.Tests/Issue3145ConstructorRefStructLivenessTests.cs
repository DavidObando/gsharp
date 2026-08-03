// <copyright file="Issue3145ConstructorRefStructLivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Issue #3145: constructor bodies run async ref-struct liveness analysis.</summary>
[Collection("ConsoleIo")]
public class Issue3145ConstructorRefStructLivenessTests
{
    private const string UnsafeSource = """
        import System
        import System.Threading.Tasks

        class Holder {
            var Value int32

            init(values []int32) {
                let read = async func() int32 {
                    var span ReadOnlySpan[int32] = values
                    await Task.Yield()
                    return span.Length
                }
                Value = read().Result
            }
        }

        """;

    private const string SafeSource = """
        import System
        import System.Threading.Tasks

        class Holder {
            var Value int32

            init(values []int32) {
                let read = async func() int32 {
                    var span ReadOnlySpan[int32] = values
                    var length = span.Length
                    await Task.Yield()
                    return length
                }
                Value = read().Result
            }
        }

        """;

    public static IEnumerable<object[]> Drivers()
    {
        foreach (var driver in Enum.GetValues<Driver>())
        {
            yield return new object[] { driver };
        }
    }

    [Theory]
    [MemberData(nameof(Drivers))]
    public void ConstructorAsyncLambda_RefStructLiveAcrossAwait_ReportsGS0219(Driver driver)
    {
        var result = Run(UnsafeSource, driver);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(new[] { "GS0219" }, result.DiagnosticIds);
    }

    [Theory]
    [MemberData(nameof(Drivers))]
    public void ConstructorAsyncLambda_RefStructDeadBeforeAwait_HasNoDiagnostics(Driver driver)
    {
        var result = Run(SafeSource, driver);

        Assert.Equal(0, result.ExitCode);
        Assert.Empty(result.DiagnosticIds);
    }

    public enum Driver
    {
        CompilerEvaluation,
        CompilerEmission,
        Interpreter,
    }

    private static DriverResult Run(string source, Driver driver)
    {
        var root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            $"issue3145-{driver}-{Guid.NewGuid():N}");
        Assert.False(Directory.Exists(root));
        Directory.CreateDirectory(root);

        try
        {
            var sourceDirectory = Directory.CreateDirectory(Path.Combine(root, "source")).FullName;
            var outputDirectory = Directory.CreateDirectory(Path.Combine(root, "output")).FullName;
            Assert.Empty(Directory.EnumerateFileSystemEntries(outputDirectory));

            var sourcePath = Path.Combine(sourceDirectory, "Probe.gs");
            File.WriteAllText(sourcePath, source);
            var result = driver switch
            {
                Driver.CompilerEvaluation => Capture(() => GSharp.Compiler.Program.Main(new[] { sourcePath })),
                Driver.CompilerEmission => Capture(() => GSharp.Compiler.Program.Main(new[]
                {
                    "/out:" + Path.Combine(outputDirectory, "Probe.dll"),
                    sourcePath,
                })),
                Driver.Interpreter => Capture(() => GSharp.Repl.Program.Main(new[] { sourcePath })),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            var ids = Regex.Matches(result.StandardOutput + result.StandardError, @"\bGS\d{4}\b")
                .Select(match => match.Value)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(id => id, StringComparer.Ordinal)
                .ToArray();
            return new DriverResult(result.ExitCode, ids);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static (int ExitCode, string StandardOutput, string StandardError) Capture(Func<int> action)
    {
        using var output = new StringWriter();
        using var error = new StringWriter();
        var previousOutput = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(output);
        Console.SetError(error);
        try
        {
            return (action(), output.ToString(), error.ToString());
        }
        finally
        {
            Console.SetOut(previousOutput);
            Console.SetError(previousError);
        }
    }

    private static string GetRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName
            ?? throw new InvalidOperationException("Could not locate repository root.");
    }

    private sealed record DriverResult(int ExitCode, string[] DiagnosticIds);
}
