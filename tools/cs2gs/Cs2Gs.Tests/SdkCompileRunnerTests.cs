// <copyright file="SdkCompileRunnerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.Pipeline;
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
