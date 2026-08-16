// <copyright file="Issue3394LocalSdkPackageSelectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3394: local migration builds must use the package produced by the
/// latest build, even when an older branch left a higher semantic version.
/// </summary>
public class Issue3394LocalSdkPackageSelectionTests
{
    [Fact]
    public void ResolveLocalSdkPackage_PrefersNewestBuildOverHigherVersion()
    {
        string root = CreateTestRoot();
        string packages = Path.Combine(root, "out", "bin", "Release", "nupkgs");
        Directory.CreateDirectory(packages);

        try
        {
            string stale = Path.Combine(packages, "Gsharp.NET.Sdk.9.0.0-gstale.nupkg");
            string current = Path.Combine(packages, "Gsharp.NET.Sdk.1.0.0-gcurrent.nupkg");
            File.WriteAllBytes(stale, Array.Empty<byte>());
            File.WriteAllBytes(current, Array.Empty<byte>());
            File.SetLastWriteTimeUtc(stale, DateTime.UtcNow.AddMinutes(-1));
            File.SetLastWriteTimeUtc(current, DateTime.UtcNow);

            (string NupkgPath, string Version)? resolved =
                GsharpTestProjectRunner.ResolveLocalSdkPackage(root);

            Assert.NotNull(resolved);
            Assert.Equal(current, resolved.Value.NupkgPath);
            Assert.Equal("1.0.0-gcurrent", resolved.Value.Version);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ResolveLocalSdkPackage_WhenWriteTimesTie_UsesOrdinalPackageName()
    {
        string root = CreateTestRoot();
        string packages = Path.Combine(root, "out", "bin", "Release", "nupkgs");
        Directory.CreateDirectory(packages);

        try
        {
            AssertOrdinalPackageNameWins(
                packages,
                () => GsharpTestProjectRunner.ResolveLocalSdkPackage(root));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ResolveNewestSdkPackage_WhenWriteTimesTie_UsesOrdinalPackageName()
    {
        string root = CreateTestRoot();
        string packages = Path.Combine(root, ".nugs");
        Directory.CreateDirectory(packages);

        try
        {
            AssertOrdinalPackageNameWins(
                packages,
                () => GsharpTestProjectRunner.ResolveNewestSdkPackage(packages));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string CreateTestRoot() =>
        Path.Combine(
            AppContext.BaseDirectory,
            "sdk-selection-tests",
            Guid.NewGuid().ToString("N"));

    private static void AssertOrdinalPackageNameWins(
        string packages,
        Func<(string NupkgPath, string Version)?> resolve)
    {
        string ordinalWinner = Path.Combine(packages, "Gsharp.NET.Sdk.9.0.0-gordinal.nupkg");
        string semanticWinner = Path.Combine(packages, "Gsharp.NET.Sdk.10.0.0-gsemantic.nupkg");
        File.WriteAllBytes(ordinalWinner, Array.Empty<byte>());
        File.WriteAllBytes(semanticWinner, Array.Empty<byte>());

        var tiedWriteTime = new DateTime(2020, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(ordinalWinner, tiedWriteTime);
        File.SetLastWriteTimeUtc(semanticWinner, tiedWriteTime);
        Assert.Equal(
            File.GetLastWriteTimeUtc(ordinalWinner),
            File.GetLastWriteTimeUtc(semanticWinner));

        (string NupkgPath, string Version)? resolved = resolve();

        Assert.NotNull(resolved);
        Assert.Equal(ordinalWinner, resolved.Value.NupkgPath);
        Assert.Equal("9.0.0-gordinal", resolved.Value.Version);
    }
}
