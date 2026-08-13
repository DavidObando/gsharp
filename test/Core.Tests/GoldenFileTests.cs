// <copyright file="GoldenFileTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests;

public sealed class GoldenFileTests : IDisposable
{
    private readonly string directory = Path.Combine(
        Path.GetDirectoryName(typeof(GoldenFileTests).Assembly.Location)!,
        "golden-file-tests",
        Guid.NewGuid().ToString("N"));

    [Fact]
    public void MismatchWritesActualAndReportsFirstDifferentLine()
    {
        string goldenPath = Path.Combine(this.directory, "sample.golden");
        Directory.CreateDirectory(this.directory);
        File.WriteAllText(goldenPath, "same\nexpected\n");

        var exception = Assert.Throws<GoldenFileException>(
            () => GoldenFile.AssertMatches(goldenPath, "same\r\nactual\r\n", update: false));

        Assert.Contains("line 2", exception.Message, StringComparison.Ordinal);
        Assert.Equal("same\nactual\n", File.ReadAllText(goldenPath + ".actual"));
    }

    [Fact]
    public void UpdateOverrideAcceptsGeneratedOutput()
    {
        string goldenPath = Path.Combine(this.directory, "sample.golden");
        GoldenFile.AssertMatches(goldenPath, "accepted\r\n", update: true);

        Assert.Equal("accepted\n", File.ReadAllText(goldenPath));
    }

    [Fact]
    public void DisabledUpdateOverrideRejectsMissingGolden()
    {
        string goldenPath = Path.Combine(this.directory, "sample.golden");

        var exception = Assert.Throws<GoldenFileException>(
            () => GoldenFile.AssertMatches(goldenPath, "generated\r\n", update: false));

        Assert.False(File.Exists(goldenPath));
        Assert.Equal("generated\n", File.ReadAllText(goldenPath + ".actual"));
        Assert.Contains("GSHARP_UPDATE_GOLDENS=1", exception.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null, "1", true)]
    [InlineData(null, "0", false)]
    [InlineData(true, "0", true)]
    [InlineData(false, "1", false)]
    public void UpdateOverridePrecedesEnvironment(
        bool? update,
        string environmentValue,
        bool expected)
    {
        Assert.Equal(expected, GoldenFile.ShouldUpdate(update, environmentValue));
    }

    public void Dispose()
    {
        if (Directory.Exists(this.directory))
        {
            Directory.Delete(this.directory, recursive: true);
        }
    }
}
