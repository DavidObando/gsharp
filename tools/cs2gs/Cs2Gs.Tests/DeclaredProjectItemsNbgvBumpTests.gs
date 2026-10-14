// <copyright file="DeclaredProjectItemsNbgvBumpTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Xml.Linq
import Xunit

/// Unit tests for (cref:DeclaredProjectItems.BumpNerdbankGitVersioningVersion)
/// (issue #2319 follow-up): when the source project's own `.csproj`
/// declares `Nerdbank.GitVersioning` directly with a literal below-floor
/// `Version` — rather than splitting the declaration across an ancestor
/// `Directory.Build.props`/`Directory.Packages.props`, the shape
/// (cref:StageExecutionContext.BuildOnlyPackageReferences) exists to
/// recover — this item is copied <b>verbatim</b> into the generated
/// `.gsproj` by `SdkCompileRunner.BuildProjectXml`'s declared-item
/// passthrough, so the bump has to happen on this list, not just via
/// (cref:StageExecutionContext.BuildOnlyPackageReferences).
open class DeclaredProjectItemsNbgvBumpTests {
    @Fact
    func BumpNerdbankGitVersioningVersion_BumpsBelowFloorLiteralVersion_PreservingOtherMetadata() {
        let items = []DeclaredProjectItem{
            DeclaredProjectItem(
                nil,
                XElement.Parse(
                    "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"3.7.115\" " +
                        "PrivateAssets=\"all\" />"
                )
            )
        }
        let rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items)
        let item = Assert.Single(rewritten)
        Assert.Equal(
            NerdbankGitVersioningPolicy.MinimumGSharpVersion,
            item.Element.Attribute(XName?("Version")!!)?.Value
        )
        Assert.Equal("all", item.Element.Attribute(XName?("PrivateAssets")!!)?.Value)
        Assert.Equal("Nerdbank.GitVersioning", item.Element.Attribute(XName?("Include")!!)?.Value)
    }

    @Fact
    func BumpNerdbankGitVersioningVersion_LeavesAtOrAboveFloorVersion_Unchanged() {
        let items = []DeclaredProjectItem{
            DeclaredProjectItem(
                nil,
                XElement.Parse("<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" />")
            )
        }
        let rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items)
        Assert.Same(items, rewritten)
    }

    @Fact
    func BumpNerdbankGitVersioningVersion_LeavesOrdinaryPackageReferences_Unchanged() {
        let items = []DeclaredProjectItem{
            DeclaredProjectItem(
                nil,
                XElement.Parse("<PackageReference Include=\"CommunityToolkit.Mvvm\" Version=\"1.0.0\" />")
            )
        }
        let rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items)
        Assert.Same(items, rewritten)
    }

    @Fact
    func BumpNerdbankGitVersioningVersion_LeavesVersionlessCpmStylePackageReference_Unchanged() {
        // CPM's consumer-side PackageReference carries no Version attribute at
        // all — nothing to bump, and this policy must never invent one (that
        // would reintroduce issue #2319's NU1008 under CPM).
        let items = []DeclaredProjectItem{
            DeclaredProjectItem(
                nil,
                XElement.Parse("<PackageReference Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />")
            )
        }
        let rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items)
        Assert.Same(items, rewritten)
        Assert.Null(Assert.Single(rewritten).Element.Attribute(XName?("Version")!!))
    }

    @Fact
    func BumpNerdbankGitVersioningVersion_LeavesNonLiteralVersion_Unchanged() {
        // An MSBuild property reference cannot be safely reasoned about
        // outside its original evaluation context (mirrors
        // NerdbankGitVersioningPolicy.TryGetRequiredBump's own contract).
        let items = []DeclaredProjectItem{
            DeclaredProjectItem(
                nil,
                XElement.Parse("<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"$$(NbgvVersion)\" />")
            )
        }
        let rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items)
        Assert.Same(items, rewritten)
    }

    @Fact
    func BumpNerdbankGitVersioningVersion_OnlyRewritesTheMatchingItem_AmongMultipleDeclaredPackages() {
        let items = []DeclaredProjectItem{
            DeclaredProjectItem(nil, XElement.Parse("<PackageReference Include=\"Serilog\" Version=\"3.1.1\" />")),
            DeclaredProjectItem(
                "'$$(Configuration)' == 'Release'",
                XElement.Parse(
                    "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"3.6.143\" " +
                        "PrivateAssets=\"all\" />"
                )
            )
        }
        let rewritten = DeclaredProjectItems.BumpNerdbankGitVersioningVersion(items)
        Assert.Equal(2, rewritten.Count)
        Assert.Equal("Serilog", rewritten[0].Element.Attribute(XName?("Include")!!)?.Value)
        Assert.Equal("3.1.1", rewritten[0].Element.Attribute(XName?("Version")!!)?.Value)
        Assert.Equal(
            NerdbankGitVersioningPolicy.MinimumGSharpVersion,
            rewritten[1].Element.Attribute(XName?("Version")!!)?.Value
        )
        Assert.Equal("'$$(Configuration)' == 'Release'", rewritten[1].ItemGroupCondition)
    }

    @Fact
    func BumpNerdbankGitVersioningVersion_HandlesEmptyOrNullInput() {
        Assert.Empty(DeclaredProjectItems.BumpNerdbankGitVersioningVersion(nil))
        Assert.Empty(DeclaredProjectItems.BumpNerdbankGitVersioningVersion(Array.Empty[DeclaredProjectItem]()))
    }
}
