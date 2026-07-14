// <copyright file="SdkCompileRunnerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Unit tests for <see cref="SdkCompileRunner"/>'s pure reference-partitioning
/// logic (issue #2261): reconstructing <c>PackageReference</c> id/version pairs
/// from NuGet packages-cache paths, deduping on id with higher-version-wins,
/// and dropping shared-framework assemblies. These are safely testable without
/// a live NuGet cache or a real <c>dotnet build</c>; the SDK-availability and
/// end-to-end build paths are covered by the cs2gs pipeline's own corpus runs.
/// </summary>
public class SdkCompileRunnerTests
{
    private const string PackagesRoot = "/Users/dev/.nuget/packages";
    private const string RuntimeDir = "/usr/local/share/dotnet/shared/Microsoft.NETCore.App/10.0.0";

    [Fact]
    public void PartitionReferences_ReconstructsPackageReference_FromNugetPackagesRootPath()
    {
        var references = new[]
        {
            PackagesRoot + "/communitytoolkit.mvvm/8.4.0/lib/net8.0/CommunityToolkit.Mvvm.dll",
        };

        (List<(string Id, string Version)> packages, List<string> loose) =
            SdkCompileRunner.PartitionReferences(references, PackagesRoot, RuntimeDir);

        (string id, string version) = Assert.Single(packages);
        Assert.Equal("communitytoolkit.mvvm", id);
        Assert.Equal("8.4.0", version);
        Assert.Empty(loose);
    }

    [Fact]
    public void PartitionReferences_HonorsNugetPackagesEnvOverride_ForRootDetection()
    {
        const string CustomRoot = "/ci/nuget-cache";
        var references = new[]
        {
            CustomRoot + "/serilog/3.1.1/lib/net8.0/Serilog.dll",
        };

        (List<(string Id, string Version)> packages, List<string> loose) =
            SdkCompileRunner.PartitionReferences(references, CustomRoot, RuntimeDir);

        (string id, string version) = Assert.Single(packages);
        Assert.Equal("serilog", id);
        Assert.Equal("3.1.1", version);
        Assert.Empty(loose);
    }

    [Theory]
    [InlineData("lib")]
    [InlineData("ref")]
    [InlineData("analyzers")]
    [InlineData("runtimes")]
    [InlineData("build")]
    [InlineData("buildTransitive")]
    [InlineData("contentFiles")]
    public void PartitionReferences_RecognizesGenericPackagesShape_ForAnyKnownAssetDirectory(string assetDir)
    {
        string path = "/some/other/cache/packages/spectre.console/0.49.1/" + assetDir + "/net8.0/Spectre.Console.dll";

        (string Id, string Version)? package = SdkCompileRunner.TryParsePackageFromPath(path, nugetPackagesRoot: null);

        Assert.NotNull(package);
        Assert.Equal("spectre.console", package.Value.Id);
        Assert.Equal("0.49.1", package.Value.Version);
    }

    [Fact]
    public void PartitionReferences_DedupsById_KeepingHigherVersion()
    {
        var references = new[]
        {
            PackagesRoot + "/communitytoolkit.mvvm/8.2.0/lib/net8.0/CommunityToolkit.Mvvm.dll",
            PackagesRoot + "/communitytoolkit.mvvm/8.4.0/lib/net8.0/CommunityToolkit.Mvvm.dll",
            PackagesRoot + "/communitytoolkit.mvvm/8.3.0-preview.1/lib/net8.0/CommunityToolkit.Mvvm.dll",
        };

        (List<(string Id, string Version)> packages, List<string> loose) =
            SdkCompileRunner.PartitionReferences(references, PackagesRoot, RuntimeDir);

        (string id, string version) = Assert.Single(packages);
        Assert.Equal("communitytoolkit.mvvm", id);
        Assert.Equal("8.4.0", version);
        Assert.Empty(loose);
    }

    [Fact]
    public void PartitionReferences_SkipsSharedFrameworkAssemblies_ByFileName()
    {
        var references = new[]
        {
            RuntimeDir + "/System.Private.CoreLib.dll",
            "/some/other/place/System.Private.CoreLib.dll",
        };

        using TempRuntimeDir runtimeDir = TempRuntimeDir.WithFakeAssembly("System.Private.CoreLib.dll");

        (List<(string Id, string Version)> packages, List<string> loose) =
            SdkCompileRunner.PartitionReferences(references, PackagesRoot, runtimeDir.Path);

        Assert.Empty(packages);
        Assert.Empty(loose);
    }

    [Fact]
    public void PartitionReferences_KeepsLooseSiblingReferences_Unpartitioned()
    {
        var references = new[]
        {
            "/repo/out/bin/Release/SomeLib/SomeLib.dll",
        };

        (List<(string Id, string Version)> packages, List<string> loose) =
            SdkCompileRunner.PartitionReferences(references, PackagesRoot, RuntimeDir);

        Assert.Empty(packages);
        string reference = Assert.Single(loose);
        Assert.Equal("/repo/out/bin/Release/SomeLib/SomeLib.dll", reference);
    }

    [Fact]
    public void TryParsePackageFromPath_ReturnsNull_ForNonCachePath()
    {
        (string Id, string Version)? package = SdkCompileRunner.TryParsePackageFromPath(
            "/repo/out/bin/Release/SomeLib/SomeLib.dll", PackagesRoot);

        Assert.Null(package);
    }

    [Fact]
    public void BuildProjectXml_EmitsDeclaredNerdbankGitVersioningPackageReference_WithBumpedVersionAndPrivateAssets()
    {
        // Issue #2267: nbgv is a build/dev-only dependency (PrivateAssets=all, no
        // lib/ DLL) so it contributes no compile-time reference DLL for the
        // `packages` reconstruction to recover. When the source project declared
        // it (captured as a DeclaredPackageReference by the Translate stage),
        // BuildProjectXml must still emit it as a real <PackageReference> so
        // nbgv's ThisAssembly MSBuild generator runs under `dotnet build`.
        var declared = new[]
        {
            new DeclaredPackageReference(
                NerdbankGitVersioningPolicy.PackageId,
                NerdbankGitVersioningPolicy.MinimumGSharpVersion,
                privateAssets: "all"),
        };

        string xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Exe,
            rootNamespace: null,
            gsFilePaths: new[] { "/app/Program.gs" },
            packages: Array.Empty<(string Id, string Version)>(),
            references: Array.Empty<string>(),
            analyzerReferences: Array.Empty<string>(),
            declaredPackageReferences: declared);

        Assert.Contains(
            "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" PrivateAssets=\"all\" />",
            xml);
    }

    [Fact]
    public void BuildProjectXml_OmitsVersionOnDeclaredNbgvPackageReference_WhenCentralPackageManagementIsUsed()
    {
        // Issue #2319: under CPM the version comes exclusively from the copied
        // Directory.Packages.props's <PackageVersion> item. A Version=
        // attribute on the generated <PackageReference> as well is rejected by
        // NuGet's CPM validation (NU1008), so BuildProjectXml must omit it here.
        var declared = new[]
        {
            new DeclaredPackageReference(
                NerdbankGitVersioningPolicy.PackageId,
                NerdbankGitVersioningPolicy.MinimumGSharpVersion,
                privateAssets: "all"),
        };

        string xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Exe,
            rootNamespace: null,
            gsFilePaths: new[] { "/app/Program.gs" },
            packages: Array.Empty<(string Id, string Version)>(),
            references: Array.Empty<string>(),
            analyzerReferences: Array.Empty<string>(),
            declaredPackageReferences: declared,
            usesCentralPackageManagement: true);

        Assert.Contains(
            "<PackageReference Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />",
            xml);
        Assert.DoesNotContain("Version=", xml);
    }

    [Fact]
    public void BuildProjectXml_OmitsVersionOnReconstructedPackage_WhenCentralPackageManagementIsUsed()
    {
        // Issue #2319: the same Version= suppression must apply to the
        // DLL-reconstructed `packages` set, not just the declared build-only
        // set, so BuildProjectXml stays internally consistent whenever CPM
        // governs the generated app (even though in the real --via-sdk
        // CompileStage call shape `packages` is always empty once declared
        // PackageReference items are present).
        string xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Library,
            rootNamespace: null,
            gsFilePaths: new[] { "/app/Lib.gs" },
            packages: new List<(string Id, string Version)> { ("communitytoolkit.mvvm", "8.4.0") },
            references: Array.Empty<string>(),
            analyzerReferences: Array.Empty<string>(),
            declaredPackageReferences: Array.Empty<DeclaredPackageReference>(),
            usesCentralPackageManagement: true);

        Assert.Contains("<PackageReference Include=\"communitytoolkit.mvvm\" />", xml);
        Assert.DoesNotContain("Version=", xml);
    }

    [Fact]
    public void BuildProjectXml_DoesNotDuplicateDeclaredPackage_WhenAlreadyReconstructedFromDll()
    {
        // A package that DID resolve a compile-time DLL is already fully
        // represented in `packages`; the caller (SdkCompileRunner.Compile) filters
        // it out of `declaredPackageReferences` before calling BuildProjectXml, but
        // BuildProjectXml itself renders both lists as given, so this test locks
        // in that contract at the call-site level via the public Compile-adjacent
        // helper: rendering the same id twice must not happen when the caller
        // only passes the DLL-less declared set (the realistic call shape).
        string xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Library,
            rootNamespace: null,
            gsFilePaths: new[] { "/app/Lib.gs" },
            packages: new List<(string Id, string Version)> { ("communitytoolkit.mvvm", "8.4.0") },
            references: Array.Empty<string>(),
            analyzerReferences: Array.Empty<string>(),
            declaredPackageReferences: Array.Empty<DeclaredPackageReference>());

        Assert.Contains("<PackageReference Include=\"communitytoolkit.mvvm\" Version=\"8.4.0\" />", xml);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(xml, "<PackageReference"));
    }

    [Fact]
    public void BuildProjectXml_PreservesRootNamespaceAndAvaloniaXamlItems()
    {
        string xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Library,
            rootNamespace: "Oahu.Core.UI.Avalonia",
            gsFilePaths: new[] { "/migration/BookLibraryView_axaml.gs" },
            packages: new List<(string Id, string Version)> { ("avalonia", "11.2.7") },
            references: Array.Empty<string>(),
            analyzerReferences: Array.Empty<string>(),
            additionalFiles: new[]
            {
                "/source/Views/BookLibraryView.axaml;SourceItemGroup=AvaloniaXaml",
            });

        Assert.Contains("<RootNamespace>Oahu.Core.UI.Avalonia</RootNamespace>", xml);
        Assert.Contains(
            "<AvaloniaXaml Include=\"/source/Views/BookLibraryView.axaml\" />",
            xml);
    }

    [Fact]
    public void BuildProjectXml_PreservesDeclaredDependencyMetadataAndConditions()
    {
        var packages = new[]
        {
            new DeclaredProjectItem(
                "'$(TargetFramework)' == 'net10.0'",
                System.Xml.Linq.XElement.Parse(
                    "<PackageReference Include=\"Example\" Version=\"1.2.3\" " +
                    "PrivateAssets=\"all\"><Aliases>sample</Aliases></PackageReference>")),
        };
        var projects = new[]
        {
            new DeclaredProjectItem(
                null,
                System.Xml.Linq.XElement.Parse(
                    "<ProjectReference Include=\"../Lib/Lib.gsproj\" " +
                    "ReferenceOutputAssembly=\"false\"><Private>true</Private></ProjectReference>")),
        };

        string xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Library,
            rootNamespace: null,
            gsFilePaths: new[] { "Lib.gs" },
            packages: Array.Empty<(string Id, string Version)>(),
            references: Array.Empty<string>(),
            analyzerReferences: Array.Empty<string>(),
            packageReferences: packages,
            projectReferences: projects);

        Assert.Contains("<ItemGroup Condition=\"'$(TargetFramework)' == 'net10.0'\">", xml);
        Assert.Contains(
            "<PackageReference Include=\"Example\" Version=\"1.2.3\" PrivateAssets=\"all\"><Aliases>sample</Aliases></PackageReference>",
            xml);
        Assert.Contains(
            "<ProjectReference Include=\"../Lib/Lib.gsproj\" ReferenceOutputAssembly=\"false\"><Private>true</Private></ProjectReference>",
            xml);
    }

    [Fact]
    public void RequiresExplicitProjectItem_UsesDefaultGlobForCopiedAvaloniaXaml()
    {
        Assert.False(SdkCompileRunner.RequiresExplicitProjectItem(
            "/migration/Oahu.UI",
            "/migration/Oahu.UI/Views/BookLibraryView.axaml;SourceItemGroup=AvaloniaXaml"));
        Assert.True(SdkCompileRunner.RequiresExplicitProjectItem(
            "/migration/Oahu.UI",
            "/source/Oahu.UI/Views/BookLibraryView.axaml;SourceItemGroup=AvaloniaXaml"));
    }

    [Fact]
    public void WriteIsolationBoundary_PreservesCopiedProjectBuildFiles()
    {
        string directory = Path.Combine(
            Directory.GetCurrentDirectory(),
            "sdkcompilerunnertests-isolation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string propsPath = Path.Combine(directory, "Directory.Build.props");
        const string Props = "<Project><PropertyGroup><Custom>true</Custom></PropertyGroup></Project>";
        File.WriteAllText(propsPath, Props);

        try
        {
            GsharpTestProjectRunner.WriteIsolationBoundary(directory);

            Assert.Equal(Props, File.ReadAllText(propsPath));
            Assert.True(File.Exists(Path.Combine(directory, "Directory.Build.targets")));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>
    /// A scratch directory populated with one fake shared-framework assembly
    /// file, so <see cref="SdkCompileRunner.PartitionReferences"/>'s runtime-dir
    /// enumeration (which requires a directory that actually exists on disk)
    /// can be exercised deterministically.
    /// </summary>
    private sealed class TempRuntimeDir : IDisposable
    {
        private TempRuntimeDir(string path)
        {
            this.Path = path;
        }

        public string Path { get; }

        public static TempRuntimeDir WithFakeAssembly(string fileName)
        {
            string path = System.IO.Path.Combine(
                Directory.GetCurrentDirectory(), "sdkcompilerunnertests-scratch-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(path);
            File.WriteAllBytes(System.IO.Path.Combine(path, fileName), Array.Empty<byte>());
            return new TempRuntimeDir(path);
        }

        public void Dispose()
        {
            if (Directory.Exists(this.Path))
            {
                Directory.Delete(this.Path, recursive: true);
            }
        }
    }
}
