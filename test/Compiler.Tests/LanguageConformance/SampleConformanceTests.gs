// <copyright file="SampleConformanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.LanguageConformance

import GSharp.Tests.LanguageConformance
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

/// The ADR-0156 §"What the conformance gate becomes" two-host parity gate,
/// final form since Phase 3c (#3176, the tree-walking evaluator is deleted):
/// emit-to-file + out-of-process `dotnet exec` remains the oracle for
/// every golden sample, and the in-process emit-to-memory hosts (bare
/// `gsc` and `gsi` script mode) are compared against it byte-wise —
/// pinning host mechanics (ALC resolution, reference closure, console and
/// exit-code protocol, unhandled-exception shape) rather than codegen. There
/// are no expected per-driver differences: the historical
/// `ExpectedDifferences` table (interpreter boundaries GS0510/GS0511/GS0514
/// and the missing gsi reference channel, #3130) was deleted with the
/// boundaries that caused it, and per the ADR no new entries may be added.
open class SampleConformanceTests {
    @Theory
    @MemberData("SingleFileSamples")
    async func SingleFileSample_ConformsAcrossAllDrivers(sampleName string) {
        let samplesDirectory string? = LocateSamplesDirectory()
        Assert.NotNull(samplesDirectory)
        let sourcePath = Path.Combine(samplesDirectory!!, sampleName)
        let goldenPath = Path.ChangeExtension(sourcePath, ".golden")
        await DriverConformanceHarness.AssertSingleFileConformsAsync(sampleName, sourcePath, goldenPath)
    }

    @Theory
    @MemberData("MultiFileSamples")
    async func MultiFileSample_EmittedRuntimeMatchesGolden(sampleName string) {
        let samplesDirectory string? = LocateSamplesDirectory()
        Assert.NotNull(samplesDirectory)
        let directoryName = sampleName.TrimEnd('/')
        let sampleDirectory = Path.Combine(samplesDirectory!!, directoryName)
        let sourcePaths = Directory
            .GetFiles(sampleDirectory, "*.gs")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let goldenPath = Path.Combine(sampleDirectory, directoryName + ".golden")
        await DriverConformanceHarness.AssertEmittedMatchesGoldenAsync(directoryName, sourcePaths, goldenPath)
    }

    @Fact
    func SingleFileSampleDiscovery_IsNonVacuous() {
        let samplesDirectory string? = LocateSamplesDirectory()
        Assert.NotNull(samplesDirectory)
        let samples = SampleConformanceData.GetSingleFileSamples(samplesDirectory)
        Assert.True(
            samples.Count >= MinimumSingleFileSampleCount,
            "Expected at least $MinimumSingleFileSampleCount single-file golden samples, found ${samples.Count}."
        )
    }

    @Fact
    func ExplicitMainSamples_AreDeclaredAndCannotPassVacuously() {
        let samplesDirectory string? = LocateSamplesDirectory()
        Assert.NotNull(samplesDirectory)
        let actual = SampleConformanceData
            .GetSingleFileSamples(samplesDirectory)
            .Where(
            (sample string) -> Regex.IsMatch(
                File.ReadAllText(Path.Combine(samplesDirectory!!, sample)),
                "(?m)^\\s*func\\s+Main\\s*\\("
            )
        )
            .OrderBy((sample string) -> sample, StringComparer.Ordinal)
            .ToArray()
        Assert.Equal(MainOnlySamples, actual)
        for sample in actual {
            // A Main-only sample with empty golden output would pass every
            // driver vacuously; require the entry point to produce evidence.
            let golden = SampleConformanceData.ReadNormalizedFile(
                Path.Combine(samplesDirectory!!, Path.ChangeExtension(sample, ".golden"))
            )
            Assert.False(string.IsNullOrEmpty(golden), "$sample must have non-empty golden output.")
        }
    }

    shared {
        private const MinimumSingleFileSampleCount int32 = 133
        private let MainOnlySamples[]string = []string{"RefStructGenericField.gs", "SpanComprehensive.gs"}
        private let WindowsSkippedSamples HashSet[string] = HashSet[string](StringComparer.Ordinal){
            "PInvoke.gs",
            "PInvokeLibraryImport.gs",
            "PInvokeLibraryImportStringReturn.gs",
            "PInvokeRefOutIn.gs",
            "PInvokeMarshalAs.gs"
        }

        func SingleFileSamples() sequence[[]object] {
            let samplesDirectory string? = LocateSamplesDirectory()
            if samplesDirectory == nil {
                yield break
            }
            for sample in SampleConformanceData.GetSingleFileSamples(samplesDirectory) {
                if !OperatingSystem.IsWindows() || !WindowsSkippedSamples.Contains(sample) {
                    yield[]object{sample}
                }
            }
        }

        func MultiFileSamples() sequence[[]object] {
            let samplesDirectory string? = LocateSamplesDirectory()
            if samplesDirectory == nil {
                yield break
            }
            for sample in SampleConformanceData.GetMultiFileSamples(samplesDirectory) {
                yield[]object{sample}
            }
        }

        private func LocateSamplesDirectory() string? -> SampleConformanceData.LocateSamplesDirectory(
            typeof(SampleConformanceTests).Assembly
        )
    }
}
