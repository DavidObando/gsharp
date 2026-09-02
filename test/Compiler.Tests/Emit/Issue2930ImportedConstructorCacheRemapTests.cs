// <copyright file="Issue2930ImportedConstructorCacheRemapTests.cs" company="GSharp">
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
/// Issue #2930: imported symbolic constructor cache entries include active
/// generic remap identities.
/// </summary>
public class Issue2930ImportedConstructorCacheRemapTests
{
    [Fact]
    public void ImportedConstructorCache_SeparatesLambdaMethodRemaps()
    {
        const string Source = """
            package Issue2930Method

            import System
            import System.Collections.Generic

            func Remap[A, B](first A, value B) B {
                var outer = List[B]()
                outer.Add(value)
                let f (B) -> B = (innerValue B) -> {
                    var inner = List[B]()
                    inner.Add(innerValue)
                    return inner[0]
                }
                return f(outer[0])
            }

            Console.WriteLine(Remap[int32, int32](0, 11))
            Console.WriteLine(Remap[int32, int32](0, 22))
            """;

        AssertRunsWithExactOutput(Source, nameof(ImportedConstructorCache_SeparatesLambdaMethodRemaps), "11\n22\n");
    }

    [Fact]
    public void ImportedConstructorCache_SeparatesClosureClassRemaps()
    {
        const string Source = """
            package Issue2930Class

            import System
            import System.Collections.Generic

            func Remap[A, B](first A, value B) B {
                var outer = List[B]()
                outer.Add(value)
                var calls = 0
                let f (B) -> B = (innerValue B) -> {
                    calls++
                    var inner = List[B]()
                    inner.Add(innerValue)
                    return inner[0]
                }
                return f(outer[0])
            }

            Console.WriteLine(Remap[int32, int32](0, 33))
            Console.WriteLine(Remap[int32, int32](0, 44))
            """;

        AssertRunsWithExactOutput(Source, nameof(ImportedConstructorCache_SeparatesClosureClassRemaps), "33\n44\n");
    }

    private static void AssertRunsWithExactOutput(string source, string name, string expected)
    {
        var assemblyPath = Compile(source, name);
        var assembly = EmittedFixture.Load(assemblyPath);
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal(expected, Run(assemblyPath, name));
        IlVerifier.Verify(assemblyPath);
    }

    private static string Compile(string source, string name)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2930ImportedConstructorCacheRemapTests), name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, name + ".dll");
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

        Assert.True(exitCode == 0, $"{name}: gsc failed:\n{stdout}\n{stderr}");
        return assemblyPath;
    }

    private static string Run(string assemblyPath, string name)
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

        Assert.True(exited, $"{name}: emitted program timed out");
        var output = outputTask.GetAwaiter().GetResult();
        var error = errorTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, $"{name}: emitted program failed:\n{error}");
        return output.ReplaceLineEndings(Environment.NewLine);
    }
}
