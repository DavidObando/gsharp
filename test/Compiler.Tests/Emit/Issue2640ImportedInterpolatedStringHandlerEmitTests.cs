// <copyright file="Issue2640ImportedInterpolatedStringHandlerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2640: imported interpolated-string-handler overloads.</summary>
public class Issue2640ImportedInterpolatedStringHandlerEmitTests
{
    [Fact]
    public void OahuStringCreate_InvariantCulture_EmitsVerifiesAndRuns()
    {
        const string Source = """
            package Oahu
            import System
            import System.Globalization

            func getTerminalProgressSequence() string {
                let state = 1
                let pct = 42
                return string.Create(CultureInfo.InvariantCulture, "\u001b]9;4;${state};${pct}\u001b\\")
            }

            Console.Write(getTerminalProgressSequence())
            """;

        var (exitCode, diagnostics, outputPath, directory) = Compile(Source);
        try
        {
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outputPath);
            Assert.Equal("\u001b]9;4;1;42\u001b\\", Run(outputPath, directory));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void StringCreate_PlainString_DoesNotBindHandlerOverload()
    {
        const string Source = """
            package Negative
            import System.Globalization

            let value = string.Create(CultureInfo.InvariantCulture, "Oahu")
            """;

        var (exitCode, diagnostics, _, directory) = Compile(Source);
        try
        {
            Assert.Equal(1, exitCode);
            Assert.Contains("GS0159", diagnostics, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static (int ExitCode, string Diagnostics, string OutputPath, string Directory) Compile(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2640",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        args.AddRange(BclReferences.Value.Select(path => "/r:" + path));
        args.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(args.ToArray());
            return (exitCode, stdout.ToString() + stderr, outputPath, directory);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string Run(string outputPath, string directory)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = directory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(outputPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec");
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}: {error}");
        return output;
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var dotnetRoot = Directory.GetParent(runtimeDirectory)!.Parent!.Parent!.FullName;
        var tfm = $"net{Environment.Version.Major}.0";
        var packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        var referenceDirectory = Directory.EnumerateDirectories(packsRoot, Environment.Version.Major + ".*")
            .OrderByDescending(path => path, StringComparer.Ordinal)
            .Select(path => Path.Combine(path, "ref", tfm))
            .First(Directory.Exists);
        return Directory.EnumerateFiles(referenceDirectory, "*.dll").ToList();
    });
}
