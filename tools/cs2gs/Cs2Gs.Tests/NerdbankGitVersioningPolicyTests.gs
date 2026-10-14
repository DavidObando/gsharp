// <copyright file="NerdbankGitVersioningPolicyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Translator.Loading
import Xunit

/// Tests for (cref:NerdbankGitVersioningPolicy) (issue #2225): a below-floor
/// literal `Nerdbank.GitVersioning` version must be bumped to the first
/// G#-capable release (`3.11.13-beta`); an at-or-above version, a prerelease
/// at or above the floor, or a non-literal (MSBuild property / range / wildcard)
/// version must be left untouched.
class NerdbankGitVersioningPolicyTests {
    @Theory
    @InlineData("3.7.115")
    @InlineData("3.6.146")
    @InlineData("3.11.12")
    @InlineData("3.11.13-alpha")
    @InlineData("3.10.0")
    @InlineData("2.0.0")
    @InlineData("3.11")
    func BelowFloorLiteral_IsBumped(version string) {
        Assert.True(NerdbankGitVersioningPolicy.TryGetRequiredBump(version, out var bumped))
        Assert.Equal(NerdbankGitVersioningPolicy.MinimumGSharpVersion, bumped)
    }

    @Theory
    @InlineData("3.11.13-beta")
    @InlineData("3.11.13")
    @InlineData("3.11.14")
    @InlineData("3.12.0")
    @InlineData("4.0.0")
    @InlineData("3.11.13-beta.2")
    @InlineData("3.11.13-rc1")
    func AtOrAboveFloor_IsNotBumped(version string) {
        Assert.False(NerdbankGitVersioningPolicy.TryGetRequiredBump(version, out var bumped))
        Assert.Null(bumped)
    }

    @Theory
    @InlineData("$$(NbgvVersion)")
    @InlineData("[3.7.0,4.0.0)")
    @InlineData("3.*")
    @InlineData("3.7.*")
    @InlineData("")
    @InlineData("   ")
    @InlineData("not-a-version")
    func NonLiteralOrUnparseable_IsNotBumped(version string) {
        Assert.False(NerdbankGitVersioningPolicy.TryGetRequiredBump(version, out var bumped))
        Assert.Null(bumped)
    }

    @Fact
    func BumpProjectXml_CentralPackageManagement_BumpsPackageVersion() {
        let xml = "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"3.7.115\" />\n" +
            "    <PackageVersion Include=\"xunit\" Version=\"2.9.2\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n"
        Assert.True(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out var bumped))
        Assert.Contains("Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\"", bumped)
        Assert.Contains("Include=\"xunit\" Version=\"2.9.2\"", bumped) // unrelated untouched

    }

    @Fact
    func BumpProjectXml_PackageReference_VersionBeforeInclude_IsBumped() {
        let xml = "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageReference Version=\"3.7.115\" Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n"
        Assert.True(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out var bumped))
        Assert.Contains("Version=\"3.11.13-beta\"", bumped)
        Assert.Contains("PrivateAssets=\"all\"", bumped)
    }

    @Fact
    func BumpProjectXml_VersionlessReference_IsUnchanged() {
        // The CPM consumer side declares no Version — the version lives in
        // Directory.Packages.props, so this file must not be rewritten.
        let xml = "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageReference Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n"
        Assert.False(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out var bumped))
        Assert.Null(bumped)
    }

    @Fact
    func BumpProjectXml_AlreadyAtFloor_IsUnchanged() {
        let xml = "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n"
        Assert.False(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out _))
    }

    @Fact
    func BumpProjectXml_PropertyVersion_IsUnchanged() {
        let xml = "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"$$(NbgvVersion)\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n"
        Assert.False(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out _))
    }

    @Fact
    func BumpProjectXml_CaseInsensitivePackageMatch_IsBumped() {
        let xml = "<Project><ItemGroup>" +
            "<packageversion include=\"Nerdbank.GitVersioning\" version=\"3.7.115\" />" +
            "</ItemGroup></Project>"
        Assert.True(NerdbankGitVersioningPolicy.TryBumpProjectXml(xml, out var bumped))
        Assert.Contains("3.11.13-beta", bumped)
    }

    @Fact
    func TryFindDeclaration_PackageReference_ExtractsVersionAndPrivateAssets() {
        let xml = "<Project>\n" + "  <ItemGroup>\n" + `    <PackageReference Include="Nerdbank.GitVersioning" Version="3.7.115" PrivateAssets="all" IncludeAssets="runtime; build" />
` + "  </ItemGroup>\n" + "</Project>\n"
        Assert.True(
            NerdbankGitVersioningPolicy.TryFindDeclaration(
                xml,
                out var version,
                out var privateAssets,
                out var includeAssets
            )
        )
        Assert.Equal("3.7.115", version)
        Assert.Equal("all", privateAssets)
        Assert.Equal("runtime; build", includeAssets)
    }

    @Fact
    func TryFindDeclaration_VersionlessPackageReference_ReturnsPrivateAssetsButNoVersion() {
        // The Oahu shape: a shared Directory.Build.props declares nbgv with no
        // Version (Central Package Management pins it elsewhere).
        let xml = "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageReference Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n"
        Assert.True(
            NerdbankGitVersioningPolicy.TryFindDeclaration(
                xml,
                out var version,
                out var privateAssets,
                out var includeAssets
            )
        )
        Assert.Null(version)
        Assert.Equal("all", privateAssets)
        Assert.Null(includeAssets)
    }

    @Fact
    func TryFindDeclaration_PackageVersion_ExtractsVersionButNoPrivateAssets() {
        // The Oahu shape: Directory.Packages.props pins the CPM version; a
        // <PackageVersion> element never carries PrivateAssets/IncludeAssets.
        let xml = "<Project>\n" +
            "  <ItemGroup>\n" +
            "    <PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"3.7.115\" />\n" +
            "  </ItemGroup>\n" +
            "</Project>\n"
        Assert.True(
            NerdbankGitVersioningPolicy.TryFindDeclaration(
                xml,
                out var version,
                out var privateAssets,
                out var includeAssets
            )
        )
        Assert.Equal("3.7.115", version)
        Assert.Null(privateAssets)
        Assert.Null(includeAssets)
    }

    @Fact
    func TryFindDeclaration_NoNbgvElement_ReturnsFalse() {
        let xml = "<Project><ItemGroup><PackageVersion Include=\"xunit\" Version=\"2.9.2\" /></ItemGroup></Project>"
        Assert.False(
            NerdbankGitVersioningPolicy.TryFindDeclaration(
                xml,
                out var version,
                out var privateAssets,
                out var includeAssets
            )
        )
        Assert.Null(version)
        Assert.Null(privateAssets)
        Assert.Null(includeAssets)
    }

    @Theory
    @InlineData("3.7.115", "3.11.13-beta")
    @InlineData("3.11.13-beta", "3.11.13-beta")
    @InlineData("4.0.0", "4.0.0")
    @InlineData(nil, "3.11.13-beta")
    @InlineData("$$(NbgvVersion)", "3.11.13-beta")
    @InlineData("[3.7.0,4.0.0)", "3.11.13-beta")
    func ResolveEffectiveVersion_ReturnsExpectedConcreteVersion(raw string?, expected string) {
        Assert.Equal(expected, NerdbankGitVersioningPolicy.ResolveEffectiveVersion(raw))
    }
}
