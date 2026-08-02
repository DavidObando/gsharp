// <copyright file="Issue2986PInvokeBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

[CollectionDefinition("Issue2986CompilerConsoleIo", DisableParallelization = true)]
public sealed class Issue2986CompilerConsoleIoCollection;

/// <summary>Issue #2986: bare <c>gsc</c> interprets while <c>/out:</c> emits.</summary>
[Collection("Issue2986CompilerConsoleIo")]
public class Issue2986PInvokeBoundaryTests
{
    [Fact]
    public void BareGsc_AllowsUnusedPInvokeDeclarationsInShippedSample()
    {
        var result = RunCompiler(LocateSample("PInvokeFunctionPointer.gs"));

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("1\n-1\n0\nSuccess.\n", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void BareGsc_RejectsPInvokeCallWithEmitRemedy()
    {
        var samplePath = LocateSample("PInvoke.gs");

        var result = RunCompiler(samplePath);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains($"{samplePath}(20,6,20,18): error GS0514:", result.StandardOutput);
        Assert.Contains("'gsc /out:<path>'", result.StandardOutput);
        Assert.Equal("Failed.\n", result.StandardError);
    }

    [Fact]
    public void GscOut_EmitsAndRunsShippedSample()
    {
        var outputDirectory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2986PInvokeBoundaryTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var outputPath = Path.Combine(outputDirectory, "PInvokeFunctionPointer.dll");
            var compile = RunCompiler(
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                LocateSample("PInvokeFunctionPointer.gs"));

            Assert.Equal(0, compile.ExitCode);
            Assert.True(File.Exists(outputPath));

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = outputDirectory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo);
            var standardOutput = process.StandardOutput.ReadToEnd();
            var standardError = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000));
            Assert.Equal(0, process.ExitCode);
            Assert.Equal("1\n-1\n0\n", standardOutput);
            Assert.Equal(string.Empty, standardError);
        }
        finally
        {
            Directory.Delete(outputDirectory, recursive: true);
        }
    }

    private static (int ExitCode, string StandardOutput, string StandardError) RunCompiler(params string[] args)
    {
        using var stdout = new StringWriter { NewLine = "\n" };
        using var stderr = new StringWriter { NewLine = "\n" };
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(args);
            return (exitCode, stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string LocateSample(string fileName)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var path = Path.Combine(directory.FullName, "samples", fileName);
            if (File.Exists(path))
            {
                return path;
            }
        }

        throw new DirectoryNotFoundException($"Could not locate samples/{fileName}.");
    }
}
