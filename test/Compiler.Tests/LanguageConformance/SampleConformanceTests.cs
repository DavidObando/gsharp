// <copyright file="SampleConformanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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

        await DriverConformanceHarness.AssertSingleFileConformsAsync(
            sampleName,
            sourcePath,
            goldenPath);
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

        await DriverConformanceHarness.AssertEmittedMatchesGoldenAsync(
            directoryName,
            sourcePaths,
            goldenPath);
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

    private static string LocateSamplesDirectory()
        => SampleConformanceData.LocateSamplesDirectory(typeof(SampleConformanceTests).Assembly);
}
