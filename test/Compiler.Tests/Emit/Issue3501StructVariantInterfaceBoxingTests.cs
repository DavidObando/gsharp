// <copyright file="Issue3501StructVariantInterfaceBoxingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3501 (Track A6 keystone): a value-type source converting to a
/// VARIANT interface target is C#'s boxing conversion composed with interface
/// variance — `ImmutableArray&lt;IMethodSymbol&gt;` → `IEnumerable&lt;ISymbol&gt;`.
/// The exact implemented interface already boxed; only the variance-composed
/// classification was missing (GS0155), in both the symbolic classifier and
/// the CLR overload-resolution applicability rule.
/// </summary>
public class Issue3501StructVariantInterfaceBoxingTests
{
    [Fact]
    public void ImmutableArray_BoxesToCovariantEnumerable()
    {
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic
            import System.Collections.Immutable
            import System.Linq

            open class Animal {
                var Name string
            }

            class Dog : Animal {
            }

            func count(items IEnumerable[Animal]) int32 {
                var n = 0
                for item in items {
                    n = n + 1
                }
                return n
            }

            let dogs = ImmutableArray.Create(Dog{ Name: "a" }, Dog{ Name: "b" })
            let widened IEnumerable[Animal] = dogs
            Console.WriteLine(count(widened))
            Console.WriteLine(count(dogs))
            Console.WriteLine(dogs.Cast[Animal]().Count())
            """);

        Assert.Equal(
            string.Join(Environment.NewLine, "2", "2", "2") + Environment.NewLine,
            output);
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3501_boxvar_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            int exitCode = RunCompiler(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            }, out string diagnostics);
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outputPath);
            return RunAssembly(directory, outputPath);
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

    private static int RunCompiler(string[] arguments, out string diagnostics)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            int exitCode = Program.Main(arguments);
            diagnostics = $"stdout:\n{stdout}\nstderr:\n{stderr}";
            return exitCode;
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string RunAssembly(string workingDirectory, string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"dotnet exec exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }
}
