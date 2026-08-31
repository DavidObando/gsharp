// <copyright file="Issue3732TransitivePackageReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression coverage for issue #3732: <c>Cs2Gs.Pipeline</c> and
/// <c>Cs2Gs.Cli</c> reach <c>Microsoft.Build.Locator</c> only transitively —
/// <c>Cs2Gs.ProjectLoading</c> declares the <c>PackageReference</c> and they
/// hold a <c>ProjectReference</c> to it — and the report was that the assembly
/// never reached <c>gsc</c>'s reference set (<c>GS9997 Could not find assembly
/// 'Microsoft.Build.Locator'</c>).
/// <para>
/// The transitive flow is NuGet's, not the pipeline's: the mirrored
/// <c>.gsproj</c> graph restores exactly like the C# graph, so the referenced
/// project's package lands in the referencing project's
/// <c>project.assets.json</c> and from there in
/// <c>@(ReferencePathWithRefAssemblies)</c>, which
/// <c>Gsharp.NET.Core.Sdk.targets</c> hands to <c>gsc</c> verbatim as
/// <c>/r:</c>. For that to hold, the migration must preserve two things about
/// the source graph, and those are what this fixture pins:
/// </para>
/// <list type="number">
/// <item>the referenced project's <c>PackageReference</c> items survive the
/// transform verbatim (id, version and metadata), so its generated project
/// restores the same package set; and</item>
/// <item>the referencing project's <c>ProjectReference</c> is retargeted at
/// that generated project, so restore walks into it — a referencing project
/// that declares no package of its own still inherits the closure.</item>
/// </list>
/// <para>
/// The end-to-end half of the same invariant — that the package assembly
/// actually reaches <c>gsc</c>'s <c>/r:</c> set for a downstream project that
/// never names the package — lives in <c>e2etests/packageref-e2e.sh</c>.
/// </para>
/// </summary>
public sealed class Issue3732TransitivePackageReferenceTests
{
    /// <summary>
    /// The migrated graph keeps the source graph's package/project shape: the
    /// library carries the <c>PackageReference</c>, the app carries only a
    /// <c>ProjectReference</c> retargeted at the library's generated project.
    /// </summary>
    [Fact]
    public void Transform_KeepsPackageReferenceOnTheLibraryAndRetargetsTheConsumer()
    {
        using var scratch = new ScratchDirectory();
        string sourceLibrary = Path.Combine(scratch.Path, "source", "Lib", "Lib.csproj");
        string sourceApp = Path.Combine(scratch.Path, "source", "App", "App.csproj");
        string generatedLibrary = Path.Combine(scratch.Path, "generated", "Lib", "Lib.gsproj");
        string generatedAppDirectory = Path.Combine(scratch.Path, "generated", "App");
        Directory.CreateDirectory(Path.GetDirectoryName(sourceLibrary));
        Directory.CreateDirectory(Path.GetDirectoryName(sourceApp));
        Directory.CreateDirectory(Path.GetDirectoryName(generatedLibrary));
        Directory.CreateDirectory(generatedAppDirectory);

        File.WriteAllText(
            sourceLibrary,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Microsoft.Build.Locator" Version="1.7.8" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(
            sourceApp,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <ProjectReference Include="..\Lib\Lib.csproj" />
              </ItemGroup>
            </Project>
            """);

        var generatedProjectPaths = new Dictionary<string, string>
        {
            [Path.GetFullPath(sourceLibrary)] = generatedLibrary,
        };

        XDocument transformedLibrary = GSharpProjectTransformer.Transform(
            sourceLibrary,
            Path.GetDirectoryName(generatedLibrary),
            "Gsharp.NET.Sdk/1.0.0",
            generatedProjectPaths);
        XElement packageReference = Single(transformedLibrary, "PackageReference");
        Assert.Equal("Microsoft.Build.Locator", packageReference.Attribute("Include")?.Value);
        Assert.Equal("1.7.8", packageReference.Attribute("Version")?.Value);

        XDocument transformedApp = GSharpProjectTransformer.Transform(
            sourceApp,
            generatedAppDirectory,
            "Gsharp.NET.Sdk/1.0.0",
            generatedProjectPaths);

        // The consumer declares no package of its own: the closure has to come
        // from the retargeted ProjectReference, or nothing supplies it.
        Assert.Empty(Named(transformedApp, "PackageReference"));
        Assert.Equal(
            Path.GetRelativePath(generatedAppDirectory, generatedLibrary).Replace('\\', '/'),
            Single(transformedApp, "ProjectReference").Attribute("Include")?.Value);
    }

    /// <summary>
    /// Issue #3501's analyzer-project transform drops every
    /// <c>Microsoft.CodeAnalysis*</c> <c>PackageReference</c>, which is exactly
    /// the shape that WOULD strand a downstream project. It is gated on the
    /// analyzer marker (<c>EnforceExtendedAnalyzerRules</c>, or a
    /// <c>PrivateAssets="all"</c> Roslyn package), and
    /// <c>Cs2Gs.ProjectLoading</c> — an ordinary library that consumes Roslyn
    /// at runtime alongside <c>Microsoft.Build.Locator</c> — must not trip it.
    /// </summary>
    [Fact]
    public void Transform_DoesNotStripRuntimeRoslynPackagesFromANonAnalyzerLibrary()
    {
        using var scratch = new ScratchDirectory();
        string sourceProject = Path.Combine(scratch.Path, "Lib.csproj");
        File.WriteAllText(
            sourceProject,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="5.6.0" />
                <PackageReference Include="Microsoft.CodeAnalysis.Workspaces.MSBuild" Version="5.6.0" />
                <PackageReference Include="Microsoft.Build.Locator" Version="1.7.8" />
              </ItemGroup>
            </Project>
            """);

        XDocument transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            scratch.Path,
            "Gsharp.NET.Sdk/1.0.0",
            new Dictionary<string, string>());

        Assert.Equal(
            new[]
            {
                "Microsoft.CodeAnalysis.CSharp",
                "Microsoft.CodeAnalysis.Workspaces.MSBuild",
                "Microsoft.Build.Locator",
            },
            Named(transformed, "PackageReference")
                .Select(reference => reference.Attribute("Include")?.Value)
                .ToArray());
    }

    /// <summary>
    /// The root cause: a migration root spelled through a symlink. NuGet keys
    /// restore graph nodes by absolute path, so the link spelling and the real
    /// one become two nodes and the referencing project's assets file loses the
    /// whole <c>ProjectReference</c> closure — which is how a transitively
    /// reached package goes missing from gsc's <c>/r:</c> set.
    /// <see cref="CanonicalRootPath"/> resolves the link before any generated
    /// project path is derived from it.
    /// </summary>
    [Fact]
    public void Resolve_FollowsASymlinkedRootComponent()
    {
        using var scratch = new ScratchDirectory();
        string real = Path.Combine(scratch.Path, "real");
        string link = Path.Combine(scratch.Path, "link");
        Directory.CreateDirectory(Path.Combine(real, "App"));
        Directory.CreateSymbolicLink(link, real);

        // Both the link itself and a not-yet-created leaf under it resolve
        // onto the real root (`--out` names a destination that does not exist).
        Assert.Equal(
            CanonicalRootPath.Resolve(real),
            CanonicalRootPath.Resolve(link));
        Assert.Equal(
            Path.Combine(CanonicalRootPath.Resolve(real), "App", "App.gsproj"),
            CanonicalRootPath.Resolve(Path.Combine(link, "App", "App.gsproj")));
    }

    /// <summary>A plain, link-free root is returned exactly as <see cref="Path.GetFullPath(string)"/> would.</summary>
    [Fact]
    public void Resolve_LeavesALinkFreeRootAlone()
    {
        using var scratch = new ScratchDirectory();
        string nested = Path.Combine(scratch.Path, "a", "b");
        Directory.CreateDirectory(nested);

        Assert.Equal(
            CanonicalRootPath.Resolve(nested),
            CanonicalRootPath.Resolve(Path.Combine(scratch.Path, "a", ".", "b")));
        Assert.True(Path.IsPathRooted(CanonicalRootPath.Resolve(nested)));
        Assert.Null(CanonicalRootPath.Resolve(null));
    }

    private static IEnumerable<XElement> Named(XDocument document, string localName) =>
        document.Descendants().Where(element => element.Name.LocalName == localName);

    private static XElement Single(XDocument document, string localName) =>
        Assert.Single(Named(document, localName));

    private sealed class ScratchDirectory : IDisposable
    {
        public ScratchDirectory()
        {
            this.Path = System.IO.Path.Combine(
                AppContext.BaseDirectory,
                "scratch-projects",
                "issue-3732",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            Directory.Delete(this.Path, recursive: true);
        }
    }
}
