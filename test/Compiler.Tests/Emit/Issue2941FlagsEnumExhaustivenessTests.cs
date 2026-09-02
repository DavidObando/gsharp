// <copyright file="Issue2941FlagsEnumExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using GSharp.Compiler;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2941: name-complete enum switches run identically regardless of
/// flags annotation, symbol origin, or switch form.
/// </summary>
public class Issue2941FlagsEnumExhaustivenessTests
{
    private const string UnmatchedSource = """
        package Issue2941.Unmatched
        import System

        @Flags
        enum Access { None = 0, Read = 1, Write = 2 }

        func F(x Access) int32 {
            return switch x {
                case Access.None: 0
                case Access.Read: 1
                case Access.Write: 2
            }
        }

        Console.WriteLine(F(Access.Read | Access.Write))
        """;

    private const string Source = """
        package Issue2941.Runtime
        import System

        @Flags
        enum Access { None = 0, Read = 1, Write = 2 }

        enum Plain { None, Read, Write }

        func importedStatement(x StringSplitOptions) int32 {
            switch x {
                case StringSplitOptions.None { return 10 }
                case StringSplitOptions.RemoveEmptyEntries { return 11 }
                case StringSplitOptions.TrimEntries { return 12 }
            }
        }

        func importedExpression(x StringSplitOptions) int32 {
            return switch x {
                case StringSplitOptions.None: 20
                case StringSplitOptions.RemoveEmptyEntries: 21
                case StringSplitOptions.TrimEntries: 22
            }
        }

        func userStatement(x Access) int32 {
            switch x {
                case Access.None { return 30 }
                case Access.Read { return 31 }
                case Access.Write { return 32 }
            }
        }

        func userExpression(x Access) int32 {
            return switch x {
                case Access.None: 40
                case Access.Read: 41
                case Access.Write: 42
            }
        }

        func plainStatement(x Plain) int32 {
            switch x {
                case Plain.None { return 50 }
                case Plain.Read { return 51 }
                case Plain.Write { return 52 }
            }
        }

        func plainExpression(x Plain) int32 {
            return switch x {
                case Plain.None: 60
                case Plain.Read: 61
                case Plain.Write: 62
            }
        }

        Console.WriteLine(importedStatement(StringSplitOptions.RemoveEmptyEntries))
        Console.WriteLine(importedExpression(StringSplitOptions.TrimEntries))
        Console.WriteLine(userStatement(Access.Read))
        Console.WriteLine(userExpression(Access.Write))
        Console.WriteLine(plainStatement(Plain.Read))
        Console.WriteLine(plainExpression(Plain.Write))
        """;

    [Fact]
    public void NameCompleteEnumSwitches_LoadAndRunWithExactOutput()
    {
        var assemblyPath = Compile(Source);
        var assembly = EmittedFixture.Load(assemblyPath);
        Assert.NotEmpty(assembly.GetTypes());

        for (var i = 0; i < 3; i++)
        {
            var result = RunBounded(assemblyPath);
            Assert.True(result.ExitCode == 0, $"emitted program failed:\n{result.Error}");
            Assert.Equal($"11{Environment.NewLine}22{Environment.NewLine}31{Environment.NewLine}42{Environment.NewLine}51{Environment.NewLine}62{Environment.NewLine}", result.Output);
        }

        IlVerifier.Verify(assemblyPath);
    }

    [Fact]
    public void UnmatchedFlagsValue_FailsLoudly()
    {
        var assemblyPath = Compile(UnmatchedSource);
        var assembly = EmittedFixture.Load(assemblyPath);
        Assert.NotEmpty(assembly.GetTypes());

        var result = RunBounded(assemblyPath);

        Assert.NotEqual(0, result.ExitCode);
        Assert.Empty(result.Output);
        Assert.Contains(
            "System.InvalidOperationException: Unmatched switch expression value.",
            result.Error);
        IlVerifier.Verify(assemblyPath);
    }

    private static string Compile(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2941FlagsEnumExhaustivenessTests));
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "Issue2941FlagsEnumExhaustiveness.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        Assert.True(exitCode == 0, $"gsc failed:\n{stdout}\n{stderr}");
        return assemblyPath;
    }

    private static (int ExitCode, string Output, string Error) RunBounded(string assemblyPath)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        Assert.NotNull(process);
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(30_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }

        Assert.True(exited, "emitted program timed out");
        var output = outputTask.GetAwaiter().GetResult();
        var error = errorTask.GetAwaiter().GetResult();
        return (
            process.ExitCode,
            output.ReplaceLineEndings(Environment.NewLine),
            error.ReplaceLineEndings(Environment.NewLine));
    }
}
