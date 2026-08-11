// <copyright file="SampleConformanceTests.cs" company="GSharp">
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
using GSharp.Tests.LanguageConformance;
using Xunit;

namespace GSharp.Compiler.Tests.LanguageConformance;

/// <summary>
/// The ADR-0156 §"What the conformance gate becomes" two-host parity gate,
/// final form since Phase 3c (#3176, the tree-walking evaluator is deleted):
/// emit-to-file + out-of-process <c>dotnet exec</c> remains the oracle for
/// every golden sample, and the in-process emit-to-memory hosts (bare
/// <c>gsc</c> and <c>gsi</c> script mode) are compared against it byte-wise —
/// pinning host mechanics (ALC resolution, reference closure, console and
/// exit-code protocol, unhandled-exception shape) rather than codegen. There
/// are no expected per-driver differences: the historical
/// <c>ExpectedDifferences</c> table (interpreter boundaries GS0510/GS0511/GS0514
/// and the missing gsi reference channel, #3130) was deleted with the
/// boundaries that caused it, and per the ADR no new entries may be added.
/// </summary>
public class SampleConformanceTests
{
    private const int MinimumSingleFileSampleCount = 124;

    private static readonly string[] MainOnlySamples =
    {
        "RefStructGenericField.gs",
        "SpanComprehensive.gs",
    };

    private static readonly HashSet<string> WindowsSkippedSamples = new(StringComparer.Ordinal)
    {
        "PInvoke.gs",
        "PInvokeLibraryImport.gs",
        "PInvokeLibraryImportStringReturn.gs",
        "PInvokeRefOutIn.gs",
        "PInvokeMarshalAs.gs",
    };

    private static readonly Regex DiagnosticIdPattern =
        new(@"\b(?:GS\d{4}|GSI\d{3})\b", RegexOptions.CultureInvariant);

    public static IEnumerable<object[]> SingleFileSamples()
    {
        var samplesDirectory = LocateSamplesDirectory();
        if (samplesDirectory is null)
        {
            yield break;
        }

        foreach (var sample in SampleConformanceData.GetSingleFileSamples(samplesDirectory))
        {
            if (!OperatingSystem.IsWindows() || !WindowsSkippedSamples.Contains(sample))
            {
                yield return new object[] { sample };
            }
        }
    }

    public static IEnumerable<object[]> MultiFileSamples()
    {
        var samplesDirectory = LocateSamplesDirectory();
        if (samplesDirectory is null)
        {
            yield break;
        }

        foreach (var sample in SampleConformanceData.GetMultiFileSamples(samplesDirectory))
        {
            yield return new object[] { sample };
        }
    }

    [Theory]
    [MemberData(nameof(SingleFileSamples))]
    public async Task SingleFileSample_ConformsAcrossAllDrivers(string sampleName)
    {
        var samplesDirectory = LocateSamplesDirectory();
        Assert.NotNull(samplesDirectory);
        var sourcePath = Path.Combine(samplesDirectory, sampleName);
        var goldenPath = Path.ChangeExtension(sourcePath, ".golden");

        var extensionsAssembly = Assembly.Load("Gsharp.Extensions");

        // Samples that consume the separately built Gsharp.Extensions assembly
        // need it on every driver's reference channel (#3130): gsc and gsi get
        // the same /r: path the emitted column compiles against, and gsc also
        // mirrors the emitted column's GS9100 suppression so the compile-time
        // console output stays identical.
        var usesExtensions = File.ReadAllText(sourcePath).Contains("Gsharp.Extensions", StringComparison.Ordinal);
        var extensionsReference = usesExtensions
            ? "/r:" + extensionsAssembly.Location
            : null;
        var gscArguments = usesExtensions
            ? new[] { extensionsReference, "/nowarn:GS9100", sourcePath }
            : new[] { sourcePath };
        var gsiArguments = usesExtensions
            ? new[] { extensionsReference, sourcePath }
            : new[] { sourcePath };

        var emitted = await RunEmittedAsync(new[] { sourcePath }, goldenPath, Path.GetFileNameWithoutExtension(sampleName));
        var gscInProcessHost = await RunDriverProcessAsync("Compiler", "gsc", sourcePath, compilerProtocol: true, gscArguments);
        var gsiInProcessHost = await RunDriverProcessAsync("Repl", "gsi", sourcePath, compilerProtocol: false, gsiArguments);

        AssertResults(
            sampleName,
            ("gsc", emitted, gscInProcessHost),
            ("gsi", emitted, gsiInProcessHost));
    }

    [Theory]
    [MemberData(nameof(MultiFileSamples))]
    public async Task MultiFileSample_EmittedRuntimeMatchesGolden(string sampleName)
    {
        var samplesDirectory = LocateSamplesDirectory();
        Assert.NotNull(samplesDirectory);
        var directoryName = sampleName.TrimEnd('/');
        var sampleDirectory = Path.Combine(samplesDirectory, directoryName);
        var sourcePaths = Directory.GetFiles(sampleDirectory, "*.gs")
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
        var goldenPath = Path.Combine(sampleDirectory, directoryName + ".golden");

        await RunEmittedAsync(sourcePaths, goldenPath, directoryName);
    }

    [Fact]
    public void SingleFileSampleDiscovery_IsNonVacuous()
    {
        var samplesDirectory = LocateSamplesDirectory();
        Assert.NotNull(samplesDirectory);

        var samples = SampleConformanceData.GetSingleFileSamples(samplesDirectory);
        Assert.True(
            samples.Count >= MinimumSingleFileSampleCount,
            $"Expected at least {MinimumSingleFileSampleCount} single-file golden samples, found {samples.Count}.");
    }

    [Fact]
    public void ExplicitMainSamples_AreDeclaredAndCannotPassVacuously()
    {
        var samplesDirectory = LocateSamplesDirectory();
        Assert.NotNull(samplesDirectory);

        var actual = SampleConformanceData.GetSingleFileSamples(samplesDirectory)
            .Where(sample => Regex.IsMatch(
                File.ReadAllText(Path.Combine(samplesDirectory, sample)),
                @"(?m)^\s*func\s+Main\s*\("))
            .OrderBy(sample => sample, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(MainOnlySamples, actual);
        foreach (var sample in actual)
        {
            // A Main-only sample with empty golden output would pass every
            // driver vacuously; require the entry point to produce evidence.
            var golden = SampleConformanceData.ReadNormalizedFile(
                Path.Combine(samplesDirectory, Path.ChangeExtension(sample, ".golden")));
            Assert.False(string.IsNullOrEmpty(golden), $"{sample} must have non-empty golden output.");
        }
    }

    private static async Task<DriverResult> RunEmittedAsync(
        string[] sourcePaths,
        string goldenPath,
        string assemblyName)
    {
        var expected = SampleConformanceData.ReadNormalizedFile(goldenPath);
        var testDirectory = Path.GetDirectoryName(typeof(SampleConformanceTests).Assembly.Location);
        Assert.NotNull(testDirectory);
        var outputDirectory = Path.Combine(testDirectory, "sample-conformance", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        var outputPath = Path.Combine(outputDirectory, assemblyName + ".dll");

        try
        {
            var usesExtensions = sourcePaths.Any(path =>
                File.ReadAllText(path).Contains("Gsharp.Extensions", StringComparison.Ordinal));
            var extensionsAssemblyPath = Assembly.Load("Gsharp.Extensions").Location;
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
            var compile = CaptureConsole(
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

            var runtime = await RunProcessAsync(
                "dotnet",
                outputDirectory,
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath);
            var result = new DriverResult(
                runtime.ExitCode,
                SampleConformanceData.NormalizeLineEndings(runtime.StandardOutput),
                compile.DiagnosticIds,
                SampleConformanceData.NormalizeLineEndings(runtime.StandardError));
            Assert.True(result.ExitCode == 0, $"{assemblyName} emitted runtime failed: {Format(result)}");
            Assert.Equal(expected, result.Output);
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
        using var stdout = new StringWriter { NewLine = Environment.NewLine };
        using var stderr = new StringWriter { NewLine = Environment.NewLine };
        var previousOut = Console.Out;
        var previousError = Console.Error;
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
        var testDirectory = Path.GetDirectoryName(typeof(SampleConformanceTests).Assembly.Location);
        Assert.NotNull(testDirectory);
        var executable = Path.GetFullPath(Path.Combine(
            testDirectory,
            "..",
            projectDirectory,
            OperatingSystem.IsWindows() ? executableName + ".exe" : executableName));
        Assert.True(File.Exists(executable), $"{executableName} executable not found at {executable}.");

        var process = await RunProcessAsync(
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
        var diagnosticIds = DiagnosticIdPattern.Matches(stdout + Environment.NewLine + stderr)
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
        var lines = SampleConformanceData.NormalizeLineEndings(value).Split(Environment.NewLine);
        var diagnosticIndex = Array.FindIndex(lines, line => DiagnosticIdPattern.IsMatch(line));
        if (diagnosticIndex >= 0)
        {
            lines = lines[..diagnosticIndex];
        }

        return string.Join(
            Environment.NewLine,
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
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo);
        Assert.NotNull(process);
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
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
        var failures = results
            .Where(result => !Equivalent(result.Expected, result.Actual))
            .Select(result =>
                $"{sample} diverged under {result.Driver}.{Environment.NewLine}"
                + $"Expected: {Format(result.Expected)}{Environment.NewLine}"
                + $"Actual:   {Format(result.Actual)}")
            .ToArray();
        Assert.True(
            failures.Length == 0,
            string.Join(Environment.NewLine + Environment.NewLine, failures));
    }

    private static string Format(DriverResult result)
        => $"rc={result.ExitCode}, diagnostics=[{string.Join(", ", result.DiagnosticIds)}], "
            + $"stdout=[{result.Output.Replace("\n", "\\n", StringComparison.Ordinal)}], "
            + $"stderr=[{result.StandardError.Replace("\n", "\\n", StringComparison.Ordinal)}]";

    private static string LocateSamplesDirectory()
        => SampleConformanceData.LocateSamplesDirectory(typeof(SampleConformanceTests).Assembly);

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
