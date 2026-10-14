// <copyright file="GoldenFileTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests

import GSharp.Tests
import System
import System.IO
import Xunit

class GoldenFileTests : IDisposable {
    private let directory string = Path.Combine(
        Path.GetDirectoryName(typeof(GoldenFileTests).Assembly.Location)!!,
        "golden-file-tests",
        Guid.NewGuid().ToString("N")
    )

    @Fact
    func MismatchWritesActualAndReportsFirstDifferentLine() {
        let goldenPath = Path.Combine(this.directory, "sample.golden")
        Directory.CreateDirectory(this.directory)
        File.WriteAllText(goldenPath, `same
expected
`)
        let exception = Assert.Throws[GoldenFileException](
            () -> GoldenFile.AssertMatches(goldenPath, "same\r\nactual\r\n", update: false)
        )
        Assert.Contains("line 2", exception.Message, StringComparison.Ordinal)
        Assert.Equal(`same
actual
`, File.ReadAllText(goldenPath + ".actual"))
    }

    @Fact
    func UpdateOverrideAcceptsGeneratedOutput() {
        let goldenPath = Path.Combine(this.directory, "sample.golden")
        GoldenFile.AssertMatches(goldenPath, "accepted\r\n", update: true)
        Assert.Equal("accepted\n", File.ReadAllText(goldenPath))
    }

    @Fact
    func DisabledUpdateOverrideRejectsMissingGolden() {
        let goldenPath = Path.Combine(this.directory, "sample.golden")
        let exception = Assert.Throws[GoldenFileException](
            () -> GoldenFile.AssertMatches(goldenPath, "generated\r\n", update: false)
        )
        Assert.False(File.Exists(goldenPath))
        Assert.Equal("generated\n", File.ReadAllText(goldenPath + ".actual"))
        Assert.Contains("GSHARP_UPDATE_GOLDENS=1", exception.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(nil, "1", true)
    @InlineData(nil, "0", false)
    @InlineData(true, "0", true)
    @InlineData(false, "1", false)
    func UpdateOverridePrecedesEnvironment(update bool?, environmentValue string, expected bool) {
        Assert.Equal(expected, GoldenFile.ShouldUpdate(update, environmentValue))
    }

    func Dispose() {
        if Directory.Exists(this.directory) {
            Directory.Delete(this.directory, recursive: true)
        }
    }
}
