// <copyright file="DriverConformanceHarness.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.LanguageConformance;

internal static class DriverConformanceHarness
{
    private static readonly Regex DiagnosticIdPattern =
        new(@"\b(?:GS\d{4}|GSI\d{3})\b", RegexOptions.CultureInvariant);

    public static async Task AssertSingleFileConformsAsync(
        string displayName,
        string sourcePath,
        string goldenPath = null)
    {
        var extensionsAssembly = Assembly.Load("Gsharp.Extensions");
        bool usesExtensions = File.ReadAllText(sourcePath)
            .Contains("Gsharp.Extensions", StringComparison.Ordinal);
        string extensionsReference = usesExtensions
            ? "/r:" + extensionsAssembly.Location
            : null;
        string[] gscArguments = usesExtensions
            ? new[] { extensionsReference, "/nowarn:GS9100", sourcePath }
            : new[] { sourcePath };
        string[] gsiArguments = usesExtensions
            ? new[] { extensionsReference, sourcePath }
            : new[] { sourcePath };

        DriverResult emitted = await RunEmittedAsync(
            new[] { sourcePath },
            Path.GetFileNameWithoutExtension(displayName));
        if (goldenPath is not null)
        {
            GoldenFile.AssertMatches(goldenPath, emitted.Output, $"{displayName} emitted output changed.");
        }

        DriverResult gscInProcessHost = await RunDriverProcessAsync(
            "Compiler",
            "gsc",
            sourcePath,
            compilerProtocol: true,
            gscArguments);
        DriverResult gsiInProcessHost = await RunDriverProcessAsync(
            "Repl",
            "gsi",
            sourcePath,
            compilerProtocol: false,
            gsiArguments);

        AssertResults(
            displayName,
            ("gsc", emitted, gscInProcessHost),
            ("gsi", emitted, gsiInProcessHost));
    }

    public static async Task AssertEmittedMatchesGoldenAsync(
        string displayName,
        string[] sourcePaths,
        string goldenPath)
    {
        DriverResult emitted = await RunEmittedAsync(sourcePaths, displayName);
        GoldenFile.AssertMatches(goldenPath, emitted.Output, $"{displayName} emitted output changed.");
    }

    private static async Task<DriverResult> RunEmittedAsync(
        string[] sourcePaths,
        string assemblyName)
    {
        string testDirectory = Path.GetDirectoryName(typeof(DriverConformanceHarness).Assembly.Location);
        Assert.NotNull(testDirectory);
        string outputDirectory = Path.Combine(
            testDirectory,
            "driver-conformance",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        string outputPath = Path.Combine(outputDirectory, assemblyName + ".dll");

        try
        {
            bool usesExtensions = sourcePaths.Any(path =>
                File.ReadAllText(path).Contains("Gsharp.Extensions", StringComparison.Ordinal));
            string extensionsAssemblyPath = Assembly.Load("Gsharp.Extensions").Location;
            if (usesExtensions)
            {
                File.Copy(
                    extensionsAssemblyPath,
                    Path.Combine(outputDirectory, "Gsharp.Extensions.dll"),
                    overwrite: true);
            }

            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            if (usesExtensions)
            {
                arguments.Add("/r:" + extensionsAssemblyPath);
            }

            arguments.AddRange(sourcePaths);
            DriverResult compile = CaptureConsole(
                () => GSharp.Compiler.Program.Main(arguments.ToArray()),
                compilerProtocol: true);
            Assert.True(
                compile.ExitCode == 0,
                $"gsc failed for {assemblyName}: {Format(compile)}");
            Assert.Equal(string.Empty, compile.StandardError);
            Assert.True(File.Exists(outputPath), $"Expected emitted assembly at {outputPath}.");

            var knownIlIssues = IlVerifier.GetKnownIssuesForSample(assemblyName);
            IlVerifier.Verify(
                outputPath,
                additionalReferences: usesExtensions ? new[] { extensionsAssemblyPath } : null,
                ignoredErrorCodes: knownIlIssues.ErrorCodes,
                ignoredErrorScope: knownIlIssues.Scope);
            Assembly.Load(File.ReadAllBytes(outputPath)).GetTypes();

            ProcessResult runtime = await RunProcessAsync(
                "dotnet",
                outputDirectory,
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath);
            var result = new DriverResult(
                runtime.ExitCode,
                GoldenFile.Normalize(runtime.StandardOutput),
                compile.DiagnosticIds,
                GoldenFile.Normalize(runtime.StandardError));
            Assert.True(result.ExitCode == 0, $"{assemblyName} emitted runtime failed: {Format(result)}");
            Assert.Equal(string.Empty, result.StandardError);
            return result;
        }
        finally
        {
            Directory.Delete(outputDirectory, recursive: true);
        }
    }

    private static DriverResult CaptureConsole(Func<int> action, bool compilerProtocol)
    {
        using var stdout = new StringWriter { NewLine = "\n" };
        using var stderr = new StringWriter { NewLine = "\n" };
        TextWriter previousOut = Console.Out;
        TextWriter previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = action();
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return CreateCliResult(exitCode, stdout.ToString(), stderr.ToString(), compilerProtocol);
    }

    private static async Task<DriverResult> RunDriverProcessAsync(
        string projectDirectory,
        string executableName,
        string sourcePath,
        bool compilerProtocol,
        string[] arguments)
    {
        string testDirectory = Path.GetDirectoryName(typeof(DriverConformanceHarness).Assembly.Location);
        Assert.NotNull(testDirectory);
        string executable = Path.GetFullPath(Path.Combine(
            testDirectory,
            "..",
            projectDirectory,
            OperatingSystem.IsWindows() ? executableName + ".exe" : executableName));
        Assert.True(File.Exists(executable), $"{executableName} executable not found at {executable}.");

        ProcessResult process = await RunProcessAsync(
            executable,
            Path.GetDirectoryName(sourcePath),
            arguments);
        return CreateCliResult(
            process.ExitCode,
            process.StandardOutput,
            process.StandardError,
            compilerProtocol);
    }

    private static DriverResult CreateCliResult(
        int exitCode,
        string stdout,
        string stderr,
        bool compilerProtocol)
    {
        string[] diagnosticIds = DiagnosticIdPattern.Matches(stdout + "\n" + stderr)
            .Select(match => match.Value)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToArray();
        return new DriverResult(
            exitCode,
            CleanCliStream(stdout, compilerProtocol),
            diagnosticIds,
            CleanCliStream(stderr, compilerProtocol));
    }

    private static string CleanCliStream(string value, bool compilerProtocol)
    {
        string[] lines = GoldenFile.Normalize(value).Split('\n');
        int diagnosticIndex = Array.FindIndex(lines, line => DiagnosticIdPattern.IsMatch(line));
        if (diagnosticIndex >= 0)
        {
            lines = lines[..diagnosticIndex];
        }

        return string.Join(
            "\n",
            lines.Where(line => !compilerProtocol || line is not "Success." and not "Failed."));
    }

    private static async Task<ProcessResult> RunProcessAsync(
        string fileName,
        string workingDirectory,
        params string[] arguments)
    {
        var startInfo = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(startInfo);
        Assert.NotNull(process);
        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            Assert.True(process.WaitForExit(5_000), $"{fileName} did not exit after it was killed.");
            await Task.WhenAll(stdoutTask, stderrTask);
            Assert.Fail($"{fileName} timed out after 30 seconds.");
        }

        return new ProcessResult(
            process.ExitCode,
            await stdoutTask,
            await stderrTask);
    }

    private static bool Equivalent(DriverResult left, DriverResult right)
        => left.ExitCode == right.ExitCode
            && string.Equals(left.Output, right.Output, StringComparison.Ordinal)
            && left.DiagnosticIds.SequenceEqual(right.DiagnosticIds, StringComparer.Ordinal)
            && string.Equals(left.StandardError, right.StandardError, StringComparison.Ordinal);

    private static void AssertResults(
        string sample,
        params (string Driver, DriverResult Expected, DriverResult Actual)[] results)
    {
        string[] failures = results
            .Where(result => !Equivalent(result.Expected, result.Actual))
            .Select(result =>
                $"{sample} diverged under {result.Driver}.\n"
                + $"Expected: {Format(result.Expected)}\n"
                + $"Actual:   {Format(result.Actual)}")
            .ToArray();
        Assert.True(failures.Length == 0, string.Join("\n\n", failures));
    }

    private static string Format(DriverResult result)
        => $"rc={result.ExitCode}, diagnostics=[{string.Join(", ", result.DiagnosticIds)}], "
            + $"stdout=[{result.Output.Replace("\n", "\\n", StringComparison.Ordinal)}], "
            + $"stderr=[{result.StandardError.Replace("\n", "\\n", StringComparison.Ordinal)}]";

    private sealed record DriverResult(
        int ExitCode,
        string Output,
        string[] DiagnosticIds,
        string StandardError);

    private sealed record ProcessResult(
        int ExitCode,
        string StandardOutput,
        string StandardError);
}
