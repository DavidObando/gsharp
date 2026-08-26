// <copyright file="Issue3552TupleKeyedDictionaryIndexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3552: a tuple-keyed <c>Dictionary</c> rejected its own key —
/// <c>IsTupleClrEquivalent</c> compared the two closed <c>ValueTuple&lt;…&gt;</c>
/// shapes by REFERENCE equality, but they can live in different reflection
/// contexts (the live-runtime <c>MakeGenericType</c> product on the
/// <c>TupleTypeSymbol</c> vs a MetadataLoadContext signature type recovered
/// from the indexer parameter), so `cache[("k", 1)]` failed GS0155
/// "'(string, int32)' to 'System.ValueTuple[string, int32]'".
/// </summary>
public class Issue3552TupleKeyedDictionaryIndexerTests
{
    [Fact]
    public void TupleKeyedDictionary_IndexerAcceptsTupleKeys()
    {
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic

            let cache = Dictionary[(string, int32), bool]()
            cache[("k", 1)] = true
            let key = ("k", 1)
            cache[key] = cache[("k", 1)]
            Console.WriteLine(cache[key])
            Console.WriteLine(cache.Count)
            """);

        Assert.Equal(
            string.Join(Environment.NewLine, "True", "1") + Environment.NewLine,
            output);
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3552_").FullName;
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
