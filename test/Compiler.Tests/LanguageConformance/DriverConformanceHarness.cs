// <copyright file="DriverConformanceHarness.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
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

    // IL offsets in the normalised dump (issue #3717). Blanked out when two
    // method bodies are compared so a single dropped instruction does not read
    // as a wholesale rewrite.
    private static readonly Regex IlOffsetPattern =
        new(@"IL_[0-9A-F]{4}", RegexOptions.CultureInvariant);

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

    /// <summary>
    /// Issue #3717: compiles the sample twice — once as the rest of this
    /// harness does (no <c>/reference:</c>, so gsc resolves imports from the
    /// host's trusted platform assemblies and every imported type is a live
    /// runtime <see cref="Type"/>) and once against the full
    /// <c>Microsoft.NETCore.App.Ref</c> closure (so gsc builds a
    /// <see cref="System.Reflection.MetadataLoadContext"/>, as every SDK build
    /// does) — and asserts the two agree.
    /// <para>
    /// A load-context defect is by definition a case where those two
    /// compilations disagree, so this assertion detects the whole family
    /// without anyone having to anticipate a specific defect. Agreement is
    /// checked strongest-first: diagnostics, then normalised IL, then runtime
    /// output against the sample's golden.
    /// </para>
    /// </summary>
    /// <param name="displayName">The sample name, for failure messages.</param>
    /// <param name="sourcePaths">The sample's source files.</param>
    /// <param name="goldenPath">The sample's golden file, or <see langword="null"/>.</param>
    /// <returns>The differential outcome, for the caller to triage.</returns>
    public static async Task<DifferentialOutcome> RunDifferentialAsync(
        string displayName,
        string[] sourcePaths,
        string goldenPath)
    {
        string assemblyName = Path.GetFileNameWithoutExtension(displayName.TrimEnd('/'));
        DriverResult tpa = await RunEmittedAsync(
            sourcePaths,
            assemblyName,
            ReferenceClosureMode.HostTrustedPlatform,
            captureIl: true);
        DriverResult refPack = await RunEmittedAsync(
            sourcePaths,
            assemblyName,
            ReferenceClosureMode.ReferencePack,
            captureIl: true);

        var differences = new List<string>();

        // (a) Diagnostics — ids and the raw compiler text, which carries the
        // locations. Catches the "member not found / throws under MLC" shapes.
        if (!tpa.DiagnosticIds.SequenceEqual(refPack.DiagnosticIds, StringComparer.Ordinal)
            || !string.Equals(tpa.CompilerOutput, refPack.CompilerOutput, StringComparison.Ordinal))
        {
            differences.Add(
                "diagnostics differ between reference closures:\n"
                + $"  host-TPA:  [{string.Join(", ", tpa.DiagnosticIds)}]\n"
                + $"{Indent(tpa.CompilerOutput)}\n"
                + $"  ref-pack:  [{string.Join(", ", refPack.DiagnosticIds)}]\n"
                + $"{Indent(refPack.CompilerOutput)}");
        }

        // (b) Emitted IL, modulo assembly-reference tokens and ordering.
        if (!string.Equals(tpa.IlDump, refPack.IlDump, StringComparison.Ordinal))
        {
            differences.Add("emitted IL differs between reference closures:\n"
                + DescribeIlDifference(tpa.IlDump, refPack.IlDump));
        }

        // (c) Runtime output, against the existing golden.
        if (!string.Equals(tpa.Output, refPack.Output, StringComparison.Ordinal)
            || tpa.ExitCode != refPack.ExitCode)
        {
            differences.Add(
                "runtime output differs between reference closures:\n"
                + $"  host-TPA:  {Format(tpa)}\n"
                + $"  ref-pack:  {Format(refPack)}");
        }
        else if (goldenPath is not null)
        {
            GoldenFile.AssertMatches(
                goldenPath,
                refPack.Output,
                $"{displayName} ref-pack runtime output does not match the golden.");
        }

        return new DifferentialOutcome(
            displayName,
            differences,
            tpa.AssemblyReferences,
            refPack.AssemblyReferences);
    }

    private static string Indent(string text)
        => string.Join(
            "\n",
            (text ?? string.Empty).Split('\n').Select(line => "    " + line));

    /// <summary>
    /// Describes how two normalised IL dumps diverge, per method rather than
    /// per line. A naive line diff is useless here: one dropped protected
    /// region shifts every subsequent IL offset, so the real finding (#3708 —
    /// two missing <c>.region Finally</c> rows) is buried under a hundred
    /// spurious lines. This reports, for each differing method, the
    /// offset-insensitive exception-region difference first and then the first
    /// divergence in the opcode sequence.
    /// </summary>
    /// <param name="expected">The host-TPA dump.</param>
    /// <param name="actual">The ref-pack dump.</param>
    /// <returns>A bounded description of the divergence.</returns>
    private static string DescribeIlDifference(string expected, string actual)
    {
        Dictionary<string, string[]> left = SplitMethods(expected);
        Dictionary<string, string[]> right = SplitMethods(actual);
        var report = new List<string>();

        foreach (string only in left.Keys.Except(right.Keys, StringComparer.Ordinal)
            .OrderBy(key => key, StringComparer.Ordinal).Take(5))
        {
            report.Add($"  emitted only by the host-TPA compile: {only}");
        }

        foreach (string only in right.Keys.Except(left.Keys, StringComparer.Ordinal)
            .OrderBy(key => key, StringComparer.Ordinal).Take(5))
        {
            report.Add($"  emitted only by the ref-pack compile: {only}");
        }

        int shown = 0;
        foreach (string key in left.Keys.Intersect(right.Keys, StringComparer.Ordinal)
            .OrderBy(key => key, StringComparer.Ordinal))
        {
            if (left[key].SequenceEqual(right[key], StringComparer.Ordinal) || shown >= 5)
            {
                continue;
            }

            shown++;
            report.Add($"  {key}");
            report.AddRange(DescribeMethodDifference(left[key], right[key]));
        }

        if (report.Count == 0)
        {
            report.Add("  dumps differ only in method ordering or whitespace");
        }

        return string.Join("\n", report);
    }

    private static IEnumerable<string> DescribeMethodDifference(string[] left, string[] right)
    {
        string[] leftRegions = OffsetInsensitive(left, "  .region ");
        string[] rightRegions = OffsetInsensitive(right, "  .region ");
        foreach (string missing in leftRegions.Except(rightRegions, StringComparer.Ordinal))
        {
            yield return $"    protected region present under host-TPA, absent under ref-pack: {missing}";
        }

        foreach (string extra in rightRegions.Except(leftRegions, StringComparer.Ordinal))
        {
            yield return $"    protected region present under ref-pack, absent under host-TPA: {extra}";
        }

        if (leftRegions.Length != rightRegions.Length)
        {
            yield return $"    region count: host-TPA {leftRegions.Length}, ref-pack {rightRegions.Length}";
        }

        string leftLocals = left.FirstOrDefault(
            line => line.StartsWith("  .locals ", StringComparison.Ordinal));
        string rightLocals = right.FirstOrDefault(
            line => line.StartsWith("  .locals ", StringComparison.Ordinal));
        if (!string.Equals(leftLocals, rightLocals, StringComparison.Ordinal))
        {
            yield return "    locals differ:"
                + $"\n      host-TPA: {leftLocals?.Trim() ?? "<none>"}"
                + $"\n      ref-pack: {rightLocals?.Trim() ?? "<none>"}";
        }

        string[] leftCode = OffsetInsensitive(left, "  IL_");
        string[] rightCode = OffsetInsensitive(right, "  IL_");
        for (int i = 0; i < Math.Max(leftCode.Length, rightCode.Length); i++)
        {
            string leftLine = i < leftCode.Length ? leftCode[i] : "<end of method>";
            string rightLine = i < rightCode.Length ? rightCode[i] : "<end of method>";
            if (!string.Equals(leftLine, rightLine, StringComparison.Ordinal))
            {
                yield return $"    first opcode divergence at instruction {i}:";
                yield return $"      host-TPA: {leftLine}";
                yield return $"      ref-pack: {rightLine}";
                yield break;
            }
        }
    }

    /// <summary>
    /// Selects the dump lines with the given prefix and blanks out IL offsets,
    /// so a shifted body does not read as a wholly different one.
    /// </summary>
    /// <param name="lines">The method's dump lines.</param>
    /// <param name="prefix">The line prefix to select.</param>
    /// <returns>Offset-insensitive lines.</returns>
    private static string[] OffsetInsensitive(string[] lines, string prefix)
        => lines
            .Where(line => line.StartsWith(prefix, StringComparison.Ordinal))
            .Select(line => IlOffsetPattern.Replace(line, "IL_x"))
            .Select(line => line.TrimStart())
            .ToArray();

    private static Dictionary<string, string[]> SplitMethods(string dump)
    {
        var methods = new Dictionary<string, string[]>(StringComparer.Ordinal);
        string current = null;
        var body = new List<string>();
        foreach (string line in (dump ?? string.Empty).Split('\n'))
        {
            if (line.StartsWith("method ", StringComparison.Ordinal))
            {
                if (current is not null)
                {
                    methods[current] = body.ToArray();
                }

                // Compiler-generated closures can share a header line;
                // disambiguate so the two dumps still pair up entry for entry.
                string candidate = line;
                for (int occurrence = 2; methods.ContainsKey(candidate); occurrence++)
                {
                    candidate = line + " #" + occurrence.ToString(CultureInfo.InvariantCulture);
                }

                current = candidate;
                body = new List<string>();
            }
            else
            {
                body.Add(line);
            }
        }

        if (current is not null)
        {
            methods[current] = body.ToArray();
        }

        return methods;
    }

    private static async Task<DriverResult> RunEmittedAsync(
        string[] sourcePaths,
        string assemblyName,
        ReferenceClosureMode referenceMode = ReferenceClosureMode.HostTrustedPlatform,
        bool captureIl = false)
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

            if (referenceMode == ReferenceClosureMode.ReferencePack)
            {
                // Issue #3717: the closure the .NET SDK passes. Supplying it
                // makes gsc bind imports through a MetadataLoadContext instead
                // of the host's live runtime types.
                foreach (string reference in ReferenceClosure.RefPackAssemblies())
                {
                    arguments.Add("/reference:" + reference);
                }
            }

            arguments.AddRange(sourcePaths);
            DriverResult compile = CaptureConsole(
                () => GSharp.Compiler.Program.Main(arguments.ToArray()),
                compilerProtocol: true);
            Assert.True(
                compile.ExitCode == 0,
                $"gsc failed for {assemblyName} ({referenceMode}): {Format(compile)}");
            Assert.Equal(string.Empty, compile.StandardError);
            Assert.True(File.Exists(outputPath), $"Expected emitted assembly at {outputPath}.");

            var knownIlIssues = IlVerifier.GetKnownIssuesForSample(assemblyName);
            IlVerifier.Verify(
                outputPath,
                additionalReferences: usesExtensions ? new[] { extensionsAssemblyPath } : null,
                ignoredErrorCodes: knownIlIssues.ErrorCodes,
                ignoredErrorScope: knownIlIssues.Scope);
            Assembly.Load(File.ReadAllBytes(outputPath)).GetTypes();
            string ilDump = captureIl ? NormalizedIlDump.Create(outputPath) : null;
            IReadOnlyList<string> assemblyReferences = captureIl
                ? NormalizedIlDump.AssemblyReferenceNames(outputPath)
                : null;

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
                GoldenFile.Normalize(runtime.StandardError),
                compile.CompilerOutput.Replace(outputDirectory, "<output>", StringComparison.Ordinal),
                ilDump,
                assemblyReferences);
            Assert.True(
                result.ExitCode == 0,
                $"{assemblyName} emitted runtime failed ({referenceMode}): {Format(result)}");
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
            CleanCliStream(stderr, compilerProtocol),
            CompilerOutput: string.Join(
                "\n",
                GoldenFile.Normalize(stdout + "\n" + stderr)
                    .Split('\n')
                    .Where(line => line is not "Success." and not "Failed.")));
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
        string StandardError,
        string CompilerOutput = "",
        string IlDump = null,
        IReadOnlyList<string> AssemblyReferences = null);

    /// <summary>
    /// The result of one differential comparison (issue #3717): the sample,
    /// every level at which the two reference closures disagreed, and the
    /// <c>AssemblyRef</c> sets each compile produced (the non-vacuity
    /// evidence that the two modes really used different reflection contexts).
    /// </summary>
    /// <param name="Sample">The sample name.</param>
    /// <param name="Differences">Human-readable divergence reports; empty when the modes agree.</param>
    /// <param name="HostTpaAssemblyReferences">AssemblyRef names emitted by the host-TPA compile.</param>
    /// <param name="RefPackAssemblyReferences">AssemblyRef names emitted by the ref-pack compile.</param>
    public sealed record DifferentialOutcome(
        string Sample,
        IReadOnlyList<string> Differences,
        IReadOnlyList<string> HostTpaAssemblyReferences,
        IReadOnlyList<string> RefPackAssemblyReferences);

    private sealed record ProcessResult(
        int ExitCode,
        string StandardOutput,
        string StandardError);
}
