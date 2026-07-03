// <copyright file="Issue1752SdkResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1752: stage-4 SDK resolution used to pin stale bits two ways —
/// (1) <c>EnsureInLocalFeed</c> never refreshed a same-version rebuilt nupkg
/// once one of that name already existed in the local <c>.nugs</c> feed, and
/// (2) <c>CompareVersions</c> ranked a prerelease suffix above its release
/// (e.g. <c>0.2.107-beta</c> outranked <c>0.2.107</c>) because an empty suffix
/// ordinally compares less than any non-empty one — backwards from SemVer.
/// </summary>
public class Issue1752SdkResolutionTests
{
    // --- Bug 2: CompareVersions SemVer precedence -----------------------

    [Fact]
    public void CompareVersions_ReleaseOutranksSamePrerelease()
    {
        Assert.True(GsharpTestProjectRunner.CompareVersions("1.2.0", "1.2.0-preview") > 0);
        Assert.True(GsharpTestProjectRunner.CompareVersions("1.2.0-preview", "1.2.0") < 0);
    }

    [Fact]
    public void CompareVersions_PrereleaseIdentifiersComparedAlphabetically()
    {
        Assert.True(GsharpTestProjectRunner.CompareVersions("1.2.0-alpha", "1.2.0-beta") < 0);
        Assert.True(GsharpTestProjectRunner.CompareVersions("1.2.0-beta", "1.2.0-alpha") > 0);
    }

    [Fact]
    public void CompareVersions_HigherPatchOutranksLower()
    {
        Assert.True(GsharpTestProjectRunner.CompareVersions("1.2.1", "1.2.0") > 0);
        Assert.True(GsharpTestProjectRunner.CompareVersions("1.2.0", "1.2.1") < 0);
    }

    [Fact]
    public void CompareVersions_EqualVersionsCompareEqual()
    {
        Assert.Equal(0, GsharpTestProjectRunner.CompareVersions("1.2.0", "1.2.0"));
        Assert.Equal(0, GsharpTestProjectRunner.CompareVersions("1.2.0-beta", "1.2.0-beta"));
    }

    [Fact]
    public void CompareVersions_MultiDigitComponentsCompareNumericallyNotLexically()
    {
        Assert.True(GsharpTestProjectRunner.CompareVersions("1.10.0", "1.9.0") > 0);
        Assert.True(GsharpTestProjectRunner.CompareVersions("1.9.0", "1.10.0") < 0);
    }

    [Fact]
    public void CompareVersions_NumericPrereleaseIdentifiersCompareNumerically()
    {
        // SemVer §11.4.2: numeric identifiers compare numerically, so "9" < "10"
        // even though "9" > "10" ordinally.
        Assert.True(GsharpTestProjectRunner.CompareVersions("1.2.0-9", "1.2.0-10") < 0);
    }

    // --- Bug 1: EnsureInLocalFeed refresh-on-change -----------------------

    [Fact]
    public void EnsureInLocalFeed_RefreshesWhenSameVersionNupkgContentChanged()
    {
        string repoRoot = CreateTempDir();
        try
        {
            string source = Path.Combine(repoRoot, "source.nupkg");
            File.WriteAllText(source, "original bits");

            GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, source);
            string target = Path.Combine(repoRoot, ".nugs", "source.nupkg");
            Assert.Equal("original bits", File.ReadAllText(target));

            // Same file name/version, rebuilt with different content.
            File.WriteAllText(source, "rebuilt bits");
            GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, source);

            Assert.Equal("rebuilt bits", File.ReadAllText(target));
        }
        finally
        {
            Directory.Delete(repoRoot, recursive: true);
        }
    }

    [Fact]
    public void EnsureInLocalFeed_DoesNotReCopyWhenNupkgUnchanged()
    {
        string repoRoot = CreateTempDir();
        try
        {
            string source = Path.Combine(repoRoot, "source.nupkg");
            File.WriteAllText(source, "same bits");

            GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, source);
            string target = Path.Combine(repoRoot, ".nugs", "source.nupkg");
            DateTime firstWriteTimeUtc = File.GetLastWriteTimeUtc(target);

            // Re-run with byte-identical content: the staged copy must not be
            // needlessly rewritten.
            System.Threading.Thread.Sleep(15);
            GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, source);

            Assert.Equal(firstWriteTimeUtc, File.GetLastWriteTimeUtc(target));
            Assert.Equal("same bits", File.ReadAllText(target));
        }
        finally
        {
            Directory.Delete(repoRoot, recursive: true);
        }
    }

    private static string CreateTempDir()
    {
        string dir = Path.Combine(Path.GetTempPath(), "gsharp-1752-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }
}
