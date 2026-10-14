// <copyright file="StdoutParityNormalizeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import Xunit

/// Regression tests for issue #1749 mode 2:
/// (cref:StdoutParity.Normalize) used to `TrimEnd('\n')`, which
/// strips *every* trailing newline, making `"a\n\n\n"` normalize equal to
/// `"a\n"`. A migrated program that gains/loses trailing blank lines (a
/// plausible `WriteLine` translation bug) would then falsely pass
/// byte-parity. The fix strips at most one trailing newline before
/// re-appending exactly one, so a single unavoidable terminal newline is still
/// tolerated but any *extra* trailing blank line registers as a real
/// difference.
class StdoutParityNormalizeTests : IDisposable {
    private let directory string = Path.Combine(
        Path.GetDirectoryName(typeof(StdoutParityNormalizeTests).Assembly.Location)!!,
        "stdout-parity-tests",
        Guid.NewGuid().ToString("N")
    )

    @Fact
    func Normalize_TripleTrailingNewline_DiffersFromSingle() {
        Assert.NotEqual(StdoutParity.Normalize(`a


`), StdoutParity.Normalize("a\n"))
    }

    @Fact
    func Normalize_SingleTerminalNewline_IsTolerated() {
        Assert.Equal(StdoutParity.Normalize("a${Environment.NewLine}"), StdoutParity.Normalize("a"))
    }

    @Fact
    func Normalize_ExtraTrailingBlankLine_IsDetectedAsDifferent() {
        Assert.NotEqual(StdoutParity.Normalize(`a
b
`), StdoutParity.Normalize(`a
b

`))
    }

    @Fact
    func Compare_ExtraTrailingBlankLine_IsAMismatch() {
        let result = StdoutParity.Compare(`a
b
`, `a
b

`)
        Assert.False(result.IsMatch)
    }

    @Fact
    func Normalize_CrlfAndLf_NormalizeEqual() {
        Assert.Equal(StdoutParity.Normalize("a\r\nb\r\n"), StdoutParity.Normalize(`a
b
`))
    }

    @Fact
    func CompareFile_MismatchWritesActualAndIncludesUpdateGuidance() {
        let goldenPath = Path.Combine(this.directory, "baseline.stdout.golden")
        Directory.CreateDirectory(this.directory)
        File.WriteAllText(goldenPath, "expected\n")
        let result = StdoutParity.CompareFile(goldenPath, "actual\r\n", update: false)
        Assert.False(result.IsMatch)
        Assert.Equal("actual\n", File.ReadAllText(goldenPath + ".actual"))
        Assert.Contains("GSHARP_UPDATE_GOLDENS=1", result.Describe(), StringComparison.Ordinal)
    }

    @Fact
    func CompareFile_UpdateOverrideWritesNormalizedGolden() {
        let goldenPath = Path.Combine(this.directory, "baseline.stdout.golden")
        let result = StdoutParity.CompareFile(goldenPath, "accepted\r\n", update: true)
        Assert.True(result.IsMatch)
        Assert.Equal("accepted\n", File.ReadAllText(goldenPath))
    }

    func Dispose() {
        if Directory.Exists(this.directory) {
            Directory.Delete(this.directory, recursive: true)
        }
    }
}
