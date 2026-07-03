// <copyright file="StdoutParityNormalizeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1749 mode 2:
/// <see cref="StdoutParity.Normalize"/> used to <c>TrimEnd('\n')</c>, which
/// strips *every* trailing newline, making <c>"a\n\n\n"</c> normalize equal to
/// <c>"a\n"</c>. A migrated program that gains/loses trailing blank lines (a
/// plausible <c>WriteLine</c> translation bug) would then falsely pass
/// byte-parity. The fix strips at most one trailing newline before
/// re-appending exactly one, so a single unavoidable terminal newline is still
/// tolerated but any *extra* trailing blank line registers as a real
/// difference.
/// </summary>
public class StdoutParityNormalizeTests
{
    [Fact]
    public void Normalize_TripleTrailingNewline_DiffersFromSingle()
    {
        Assert.NotEqual(StdoutParity.Normalize("a\n\n\n"), StdoutParity.Normalize("a\n"));
    }

    [Fact]
    public void Normalize_SingleTerminalNewline_IsTolerated()
    {
        Assert.Equal(StdoutParity.Normalize("a\n"), StdoutParity.Normalize("a"));
    }

    [Fact]
    public void Normalize_ExtraTrailingBlankLine_IsDetectedAsDifferent()
    {
        Assert.NotEqual(StdoutParity.Normalize("a\nb\n"), StdoutParity.Normalize("a\nb\n\n"));
    }

    [Fact]
    public void Compare_ExtraTrailingBlankLine_IsAMismatch()
    {
        StdoutParityResult result = StdoutParity.Compare("a\nb\n", "a\nb\n\n");
        Assert.False(result.IsMatch);
    }

    [Fact]
    public void Normalize_CrlfAndLf_NormalizeEqual()
    {
        Assert.Equal(StdoutParity.Normalize("a\r\nb\r\n"), StdoutParity.Normalize("a\nb\n"));
    }
}
