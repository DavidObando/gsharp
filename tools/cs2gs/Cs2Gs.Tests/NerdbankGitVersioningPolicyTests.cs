// <copyright file="NerdbankGitVersioningPolicyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Tests for <see cref="NerdbankGitVersioningPolicy"/> (issue #2225): a below-floor
/// literal <c>Nerdbank.GitVersioning</c> version must be bumped to the first
/// G#-capable release (<c>3.11.13-beta</c>); an at-or-above version, a prerelease
/// at or above the floor, or a non-literal (MSBuild property / range / wildcard)
/// version must be left untouched.
/// </summary>
public sealed class NerdbankGitVersioningPolicyTests
{
    [Theory]
    [InlineData("3.7.115")]        // Oahu's pinned version
    [InlineData("3.6.146")]
    [InlineData("3.11.12")]        // one patch below the floor's release
    [InlineData("3.11.13-alpha")]  // same release, earlier prerelease
    [InlineData("3.10.0")]
    [InlineData("2.0.0")]
    [InlineData("3.11")]           // 3.11.0 < 3.11.13-beta
    public void BelowFloorLiteral_IsBumped(string version)
    {
        Assert.True(NerdbankGitVersioningPolicy.TryGetRequiredBump(version, out string bumped));
        Assert.Equal(NerdbankGitVersioningPolicy.MinimumGSharpVersion, bumped);
    }

    [Theory]
    [InlineData("3.11.13-beta")]   // exactly the floor
    [InlineData("3.11.13")]        // stable release > the beta floor
    [InlineData("3.11.14")]
    [InlineData("3.12.0")]
    [InlineData("4.0.0")]
    [InlineData("3.11.13-beta.2")] // later prerelease of the same release
    [InlineData("3.11.13-rc1")]    // 'rc1' > 'beta' alphabetically
    public void AtOrAboveFloor_IsNotBumped(string version)
    {
        Assert.False(NerdbankGitVersioningPolicy.TryGetRequiredBump(version, out string bumped));
        Assert.Null(bumped);
    }

    [Theory]
    [InlineData("$(NbgvVersion)")] // MSBuild property indirection
    [InlineData("[3.7.0,4.0.0)")]  // version range
    [InlineData("3.*")]            // floating
    [InlineData("3.7.*")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-version")]
    public void NonLiteralOrUnparseable_IsNotBumped(string version)
    {
        Assert.False(NerdbankGitVersioningPolicy.TryGetRequiredBump(version, out string bumped));
        Assert.Null(bumped);
    }

    [Fact]
    public void BumpProjectXml_CentralPackageManagement_BumpsPackageVersion()
    {
        string xml =
            "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"3.7.115\" />\n" +
            "    <PackageVersion Include=\"xunit\" Version=\"2.9.2\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n";

        Assert.True(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out string bumped));
        Assert.Contains("Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\"", bumped);
        Assert.Contains("Include=\"xunit\" Version=\"2.9.2\"", bumped); // unrelated untouched
    }

    [Fact]
    public void BumpProjectXml_PackageReference_VersionBeforeInclude_IsBumped()
    {
        string xml =
            "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageReference Version=\"3.7.115\" Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n";

        Assert.True(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out string bumped));
        Assert.Contains("Version=\"3.11.13-beta\"", bumped);
        Assert.Contains("PrivateAssets=\"all\"", bumped);
    }

    [Fact]
    public void BumpProjectXml_VersionlessReference_IsUnchanged()
    {
        // The CPM consumer side declares no Version — the version lives in
        // Directory.Packages.props, so this file must not be rewritten.
        string xml =
            "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageReference Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n";

        Assert.False(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out string bumped));
        Assert.Null(bumped);
    }

    [Fact]
    public void BumpProjectXml_AlreadyAtFloor_IsUnchanged()
    {
        string xml =
            "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n";

        Assert.False(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out _));
    }

    [Fact]
    public void BumpProjectXml_PropertyVersion_IsUnchanged()
    {
        string xml =
            "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"$(NbgvVersion)\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n";

        Assert.False(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out _));
    }

    [Fact]
    public void BumpProjectXml_CaseInsensitivePackageMatch_IsBumped()
    {
        string xml = "<Project><ItemGroup>" +
            "<packageversion include=\"Nerdbank.GitVersioning\" version=\"3.7.115\" />" +
            "</ItemGroup></Project>";

        Assert.True(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out string bumped));
        Assert.Contains("3.11.13-beta", bumped);
    }
}
