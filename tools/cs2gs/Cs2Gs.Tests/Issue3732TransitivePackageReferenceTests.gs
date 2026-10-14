// <copyright file="Issue3732TransitivePackageReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Xml.Linq
import Cs2Gs.Pipeline
import Xunit

/// Regression coverage for issue #3732: `Cs2Gs.Pipeline` and
/// `Cs2Gs.Cli` reach `Microsoft.Build.Locator` only transitively —
/// `Cs2Gs.ProjectLoading` declares the `PackageReference` and they
/// hold a `ProjectReference` to it — and the report was that the assembly
/// never reached `gsc`'s reference set (`GS9997 Could not find assembly
/// 'Microsoft.Build.Locator'`).
///
/// The transitive flow is NuGet's, not the pipeline's: the mirrored
/// `.gsproj` graph restores exactly like the C# graph, so the referenced
/// project's package lands in the referencing project's
/// `project.assets.json` and from there in
/// `@(ReferencePathWithRefAssemblies)`, which
/// `Gsharp.NET.Core.Sdk.targets` hands to `gsc` verbatim as
/// `/r:`. For that to hold, the migration must preserve two things about
/// the source graph, and those are what this fixture pins:
///
/// 1. the referenced project's `PackageReference` items survive the transform verbatim (id, version and
/// metadata), so its generated project restores the same package set; and
/// 2. the referencing project's `ProjectReference` is retargeted at that generated project, so restore
/// walks into it — a referencing project that declares no package of its own still inherits the
/// closure.
///
/// The end-to-end half of the same invariant — that the package assembly
/// actually reaches `gsc`'s `/r:` set for a downstream project that
/// never names the package — lives in `e2etests/packageref-e2e.sh`.
class Issue3732TransitivePackageReferenceTests {
    /// The migrated graph keeps the source graph's package/project shape: the
    /// library carries the `PackageReference`, the app carries only a
    /// `ProjectReference` retargeted at the library's generated project.
    @Fact
    func Transform_KeepsPackageReferenceOnTheLibraryAndRetargetsTheConsumer() {
        using let scratch = Issue3732TransitivePackageReferenceTests.ScratchDirectory()
        let sourceLibrary = Path.Combine(scratch.Path, "source", "Lib", "Lib.csproj")
        let sourceApp = Path.Combine(scratch.Path, "source", "App", "App.csproj")
        let generatedLibrary = Path.Combine(scratch.Path, "generated", "Lib", "Lib.gsproj")
        let generatedAppDirectory = Path.Combine(scratch.Path, "generated", "App")
        Directory.CreateDirectory(Path.GetDirectoryName(sourceLibrary)!!)
        Directory.CreateDirectory(Path.GetDirectoryName(sourceApp)!!)
        Directory.CreateDirectory(Path.GetDirectoryName(generatedLibrary)!!)
        Directory.CreateDirectory(generatedAppDirectory)
        File.WriteAllText(sourceLibrary, `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.Build.Locator" Version="1.7.8" />
  </ItemGroup>
</Project>`)
        File.WriteAllText(sourceApp, `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="..\Lib\Lib.csproj" />
  </ItemGroup>
</Project>`)
        let generatedProjectPaths = Dictionary[string, string]{[Path.GetFullPath(sourceLibrary)] = generatedLibrary}
        let transformedLibrary = GSharpProjectTransformer.Transform(
            sourceLibrary,
            Path.GetDirectoryName(generatedLibrary),
            "Gsharp.NET.Sdk/1.0.0",
            generatedProjectPaths
        )
        let packageReference = Issue3732TransitivePackageReferenceTests.Single(transformedLibrary, "PackageReference")
        Assert.Equal("Microsoft.Build.Locator", packageReference.Attribute(XName?("Include")!!)?.Value)
        Assert.Equal("1.7.8", packageReference.Attribute(XName?("Version")!!)?.Value)
        let transformedApp = GSharpProjectTransformer.Transform(
            sourceApp,
            generatedAppDirectory,
            "Gsharp.NET.Sdk/1.0.0",
            generatedProjectPaths
        )
        // The consumer declares no package of its own: the closure has to come
        // from the retargeted ProjectReference, or nothing supplies it.
        Assert.Empty(Named(transformedApp, "PackageReference"))
        Assert.Equal(
            Path.GetRelativePath(generatedAppDirectory, generatedLibrary).Replace('\\', '/'),
            Issue3732TransitivePackageReferenceTests
                .Single(transformedApp, "ProjectReference")
                .Attribute(XName?("Include")!!)
                ?.Value
        )
    }

    /// Issue #3501's analyzer-project transform drops every
    /// `Microsoft.CodeAnalysis*` `PackageReference`, which is exactly
    /// the shape that WOULD strand a downstream project. It is gated on the
    /// analyzer marker (`EnforceExtendedAnalyzerRules`, or a
    /// `PrivateAssets="all"` Roslyn package), and
    /// `Cs2Gs.ProjectLoading` — an ordinary library that consumes Roslyn
    /// at runtime alongside `Microsoft.Build.Locator` — must not trip it.
    @Fact
    func Transform_DoesNotStripRuntimeRoslynPackagesFromANonAnalyzerLibrary() {
        using let scratch = Issue3732TransitivePackageReferenceTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "Lib.csproj")
        File.WriteAllText(sourceProject, `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="5.6.0" />
    <PackageReference Include="Microsoft.CodeAnalysis.Workspaces.MSBuild" Version="5.6.0" />
    <PackageReference Include="Microsoft.Build.Locator" Version="1.7.8" />
  </ItemGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            scratch.Path,
            "Gsharp.NET.Sdk/1.0.0",
            Dictionary[string, string]()
        )
        Assert.Equal(
            []string{
                "Microsoft.CodeAnalysis.CSharp",
                "Microsoft.CodeAnalysis.Workspaces.MSBuild",
                "Microsoft.Build.Locator"
            },
            Named(transformed, "PackageReference").Select(
                (reference XElement) -> reference.Attribute(XName?("Include")!!)?.Value
            )
                .ToArray()
        )
    }

    /// The root cause: a migration root spelled through a symlink. NuGet keys
    /// restore graph nodes by absolute path, so the link spelling and the real
    /// one become two nodes and the referencing project's assets file loses the
    /// whole `ProjectReference` closure — which is how a transitively
    /// reached package goes missing from gsc's `/r:` set.
    /// (cref:CanonicalRootPath) resolves the link before any generated
    /// project path is derived from it.
    @Fact
    func Resolve_FollowsASymlinkedRootComponent() {
        using let scratch = Issue3732TransitivePackageReferenceTests.ScratchDirectory()
        let real = Path.Combine(scratch.Path, "real")
        let link = Path.Combine(scratch.Path, "link")
        Directory.CreateDirectory(Path.Combine(real, "App"))
        Directory.CreateSymbolicLink(link, real)
        // Both the link itself and a not-yet-created leaf under it resolve
        // onto the real root (`--out` names a destination that does not exist).
        Assert.Equal(CanonicalRootPath.Resolve(real), CanonicalRootPath.Resolve(link))
        Assert.Equal(
            Path.Combine(CanonicalRootPath.Resolve(real)!!, "App", "App.gsproj"),
            CanonicalRootPath.Resolve(Path.Combine(link, "App", "App.gsproj"))
        )
    }

    /// A plain, link-free root is returned exactly as (cref:Path.GetFullPath(string)) would.
    @Fact
    func Resolve_LeavesALinkFreeRootAlone() {
        using let scratch = Issue3732TransitivePackageReferenceTests.ScratchDirectory()
        let nested = Path.Combine(scratch.Path, "a", "b")
        Directory.CreateDirectory(nested)
        Assert.Equal(
            CanonicalRootPath.Resolve(nested),
            CanonicalRootPath.Resolve(Path.Combine(scratch.Path, "a", ".", "b"))
        )
        Assert.True(Path.IsPathRooted(CanonicalRootPath.Resolve(nested)))
        Assert.Null(CanonicalRootPath.Resolve(nil))
    }

    private class ScratchDirectory : IDisposable {
        init() {
            this.Path = Path.Combine(
                AppContext.BaseDirectory,
                "scratch-projects",
                "issue-3732",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(this.Path)
        }

        prop Path string {
            get;
        }

        func Dispose() {
            Directory.Delete(this.Path, recursive: true)
        }
    }

    shared {
        private func Named(document XDocument, localName string) IEnumerable[XElement] -> document.Descendants().Where(
            (element XElement) -> element.Name.LocalName == localName
        )

        private func Single(document XDocument, localName string) XElement -> Assert.Single(Named(document, localName))
    }
}
