// <copyright file="DeclaredProjectItemsNbgvBumpTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Xml.Linq;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Unit tests for <see cref="DeclaredProjectItems.BumpNerdbankGitVersioningVersion"/>
/// (issue #2319 follow-up): when the source project's own <c>.csproj</c>
/// declares <c>Nerdbank.GitVersioning</c> directly with a literal below-floor
/// <c>Version</c> — rather than splitting the declaration across an ancestor
/// <c>Directory.Build.props</c>/<c>Directory.Packages.props</c>, the shape
/// <see cref="StageExecutionContext.BuildOnlyPackageReferences"/> exists to
/// recover — this item is copied <b>verbatim</b> into the generated
/// <c>.gsproj</c> by <c>SdkCompileRunner.BuildProjectXml</c>'s declared-item
/// passthrough, so the bump has to happen on this list, not just via
/// <see cref="StageExecutionContext.BuildOnlyPackageReferences"/>.
/// </summary>
public class DeclaredProjectItemsNbgvBumpTests
{
    [Fact]
    public void BumpNerdbankGitVersioningVersion_BumpsBelowFloorLiteralVersion_PreservingOtherMetadata()
    {
        var items = new[]
        {
            new DeclaredProjectItem(
                null,
                XElement.Parse(
                    "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"3.7.115\" " +
                    "PrivateAssets=\"all\" />")),
        };

        IReadOnlyList<DeclaredProjectItem> rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items);

        DeclaredProjectItem item = Assert.Single(rewritten);
        Assert.Equal(NerdbankGitVersioningPolicy.MinimumGSharpVersion, item.Element.Attribute("Version")?.Value);
        Assert.Equal("all", item.Element.Attribute("PrivateAssets")?.Value);
        Assert.Equal("Nerdbank.GitVersioning", item.Element.Attribute("Include")?.Value);
    }

    [Fact]
    public void BumpNerdbankGitVersioningVersion_LeavesAtOrAboveFloorVersion_Unchanged()
    {
        var items = new[]
        {
            new DeclaredProjectItem(
                null,
                XElement.Parse(
                    "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" />")),
        };

        IReadOnlyList<DeclaredProjectItem> rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items);

        Assert.Same(items, rewritten);
    }

    [Fact]
    public void BumpNerdbankGitVersioningVersion_LeavesOrdinaryPackageReferences_Unchanged()
    {
        var items = new[]
        {
            new DeclaredProjectItem(
                null,
                XElement.Parse("<PackageReference Include=\"CommunityToolkit.Mvvm\" Version=\"1.0.0\" />")),
        };

        IReadOnlyList<DeclaredProjectItem> rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items);

        Assert.Same(items, rewritten);
    }

    [Fact]
    public void BumpNerdbankGitVersioningVersion_LeavesVersionlessCpmStylePackageReference_Unchanged()
    {
        // CPM's consumer-side PackageReference carries no Version attribute at
        // all — nothing to bump, and this policy must never invent one (that
        // would reintroduce issue #2319's NU1008 under CPM).
        var items = new[]
        {
            new DeclaredProjectItem(
                null,
                XElement.Parse("<PackageReference Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />")),
        };

        IReadOnlyList<DeclaredProjectItem> rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items);

        Assert.Same(items, rewritten);
        Assert.Null(Assert.Single(rewritten).Element.Attribute("Version"));
    }

    [Fact]
    public void BumpNerdbankGitVersioningVersion_LeavesNonLiteralVersion_Unchanged()
    {
        // An MSBuild property reference cannot be safely reasoned about
        // outside its original evaluation context (mirrors
        // NerdbankGitVersioningPolicy.TryGetRequiredBump's own contract).
        var items = new[]
        {
            new DeclaredProjectItem(
                null,
                XElement.Parse(
                    "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"$(NbgvVersion)\" />")),
        };

        IReadOnlyList<DeclaredProjectItem> rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items);

        Assert.Same(items, rewritten);
    }

    [Fact]
    public void BumpNerdbankGitVersioningVersion_OnlyRewritesTheMatchingItem_AmongMultipleDeclaredPackages()
    {
        var items = new[]
        {
            new DeclaredProjectItem(
                null,
                XElement.Parse("<PackageReference Include=\"Serilog\" Version=\"3.1.1\" />")),
            new DeclaredProjectItem(
                "'$(Configuration)' == 'Release'",
                XElement.Parse(
                    "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"3.6.143\" " +
                    "PrivateAssets=\"all\" />")),
        };

        IReadOnlyList<DeclaredProjectItem> rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items);

        Assert.Equal(2, rewritten.Count);
        Assert.Equal("Serilog", rewritten[0].Element.Attribute("Include")?.Value);
        Assert.Equal("3.1.1", rewritten[0].Element.Attribute("Version")?.Value);
        Assert.Equal(
            NerdbankGitVersioningPolicy.MinimumGSharpVersion,
            rewritten[1].Element.Attribute("Version")?.Value);
        Assert.Equal("'$(Configuration)' == 'Release'", rewritten[1].ItemGroupCondition);
    }

    [Fact]
    public void BumpNerdbankGitVersioningVersion_HandlesEmptyOrNullInput()
    {
        Assert.Empty(DeclaredProjectItems.BumpNerdbankGitVersioningVersion(null));
        Assert.Empty(DeclaredProjectItems.BumpNerdbankGitVersioningVersion(System.Array.Empty<DeclaredProjectItem>()));
    }
}
