// <copyright file="TransformationsPackageTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.PublicApi

import GSharp.CodeAnalysis.Transformations
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.IO.Compression
import System.Linq
import System.Xml.Linq
import Xunit

/// Issue #6130: `GSharp.CodeAnalysis.Transformations` is a NuGet package next to
/// `GSharp.CodeAnalysis.Analyzers.Testing`. Its public API has a snapshot, and the package that the
/// build packs holds the assembly and the JSON schema, and depends on no
/// `GSharp.Core` package (the host supplies Core).
class TransformationsPackageTests {
    private const SnapshotFileName string = "gsharp-transformations-public-api.txt"

    @Fact
    func Transformations_PublicApi_MatchesSnapshot() {
        let lines = CorePublicApiSnapshotTests.RenderPublicApi(typeof(TransformationProgram).Assembly.Location)
        Assert.Contains(
            lines,
            (line string) -> line.StartsWith("type ", StringComparison.Ordinal) && line.Contains(
                " GSharp.CodeAnalysis.Transformations.TransformationProgram ",
                StringComparison.Ordinal
            )
        )
        GoldenFile.AssertMatches(
            Path.Combine(RepoRoot(), "test", "Core.Tests", "Baselines", SnapshotFileName),
            string.Join("\n", lines) + "\n",
            "The public API of GSharp.CodeAnalysis.Transformations changed. It is a published package; if the " +
                "change is intended, regenerate with GSHARP_UPDATE_GOLDENS=1 and review the diff as an API change."
        )
    }

    @Fact
    func Package_HoldsTheAssemblyAndTheSchema_AndNoCoreDependency() {
        let nupkg = LatestPackage()
        using let archive = ZipFile.OpenRead(nupkg)
        let entries = archive.Entries.Select((e ZipArchiveEntry) -> e.FullName.Replace('\\', '/')).ToHashSet()
        Assert.Single(entries, (e string) -> e.StartsWith("lib/", StringComparison.Ordinal) && e.EndsWith(
            "/GSharp.CodeAnalysis.Transformations.dll",
            StringComparison.Ordinal
        ))
        Assert.Contains("schema/transformation-program.schema.json", entries)
        Assert.Contains("README.md", entries)
        Assert.Contains("icon.png", entries)
        // Core is host-supplied: neither bundled nor a package dependency.
        Assert.DoesNotContain(entries, (e string) -> e.EndsWith("/GSharp.Core.dll", StringComparison.OrdinalIgnoreCase))
        let nuspecEntry = Assert.Single(archive.Entries, (e ZipArchiveEntry) -> e.FullName.EndsWith(".nuspec", StringComparison.Ordinal))
        using let stream = nuspecEntry.Open()
        let nuspec = XDocument.Load(stream)
        let metadata = nuspec.Root!!.Elements().Single((e XElement) -> e.Name.LocalName == "metadata")
        Assert.Equal("GSharp.CodeAnalysis.Transformations", Value(metadata, "id"))
        Assert.Equal("MIT", Value(metadata, "license"))
        Assert.False(string.IsNullOrWhiteSpace(Value(metadata, "description")))
        let dependencies = metadata
            .Descendants()
            .Where((e XElement) -> e.Name.LocalName == "dependency")
            .Select((e XElement) -> e.Attribute(XName?("id")!!)?.Value ?? "")
            .ToList()
        Assert.DoesNotContain(dependencies, (id string) -> id.StartsWith("GSharp.Core", StringComparison.OrdinalIgnoreCase))
        Assert.DoesNotContain(dependencies, (id string) -> id == "Core")
    }

    private func Value(metadata XElement, name string) string? -> metadata
        .Elements()
        .FirstOrDefault((e XElement) -> e.Name.LocalName == name)
        ?.Value

    // The package that the build of this test run packed: the newest one in out/bin/<config>/nupkgs,
    // where <config> is the configuration of this test assembly (out/bin/<config>/Core.Tests).
    private func LatestPackage() string {
        let testDirectory = DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar))
        let nupkgs = Path.Combine(testDirectory.Parent!!.FullName, "nupkgs")
        let packages = List[FileInfo]()
        if Directory.Exists(nupkgs) {
            for file in Directory.GetFiles(nupkgs, "GSharp.CodeAnalysis.Transformations.*.nupkg") {
                if !file.EndsWith(".symbols.nupkg", StringComparison.Ordinal) {
                    packages.Add(FileInfo(file))
                }
            }
        }
        Assert.True(packages.Count > 0, "No GSharp.CodeAnalysis.Transformations package in ${nupkgs}; the build packs it.")
        return packages.OrderByDescending((f FileInfo) -> f.LastWriteTimeUtc).First().FullName
    }

    private func RepoRoot() string {
        var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
        while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
            directory = directory.Parent
        }
        Assert.NotNull(directory)
        return directory!!.FullName
    }
}
