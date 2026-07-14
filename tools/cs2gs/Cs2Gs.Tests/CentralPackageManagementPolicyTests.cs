// <copyright file="CentralPackageManagementPolicyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Unit tests for <see cref="CentralPackageManagementPolicy"/> (issue #2319):
/// the presence of a <c>Directory.Packages.props</c> file does not by itself
/// enable NuGet Central Package Management — the
/// <c>ManagePackageVersionsCentrally</c> MSBuild property must resolve
/// <see langword="true"/>, either in that file itself (the documented,
/// overwhelmingly common location) or in a shared ancestor
/// <c>Directory.Build.props</c>.
/// </summary>
public class CentralPackageManagementPolicyTests
{
    [Fact]
    public void IsEnabled_ReturnsTrue_WhenPropertyDeclaredInCentralPackagesFile()
    {
        using var scratch = new ScratchDirectory();
        string projectDir = Path.Combine(scratch.Path, "src", "App");
        Directory.CreateDirectory(projectDir);

        bool enabled = CentralPackageManagementPolicy.IsEnabled(
            projectDir,
            scratch.Path,
            """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
            </Project>
            """);

        Assert.True(enabled);
    }

    [Fact]
    public void IsEnabled_ReturnsFalse_WhenCentralPackagesFilePresentButPropertyUnset()
    {
        using var scratch = new ScratchDirectory();
        string projectDir = Path.Combine(scratch.Path, "src", "App");
        Directory.CreateDirectory(projectDir);

        bool enabled = CentralPackageManagementPolicy.IsEnabled(
            projectDir,
            scratch.Path,
            """
            <Project>
              <ItemGroup>
                <PackageVersion Include="Nerdbank.GitVersioning" Version="3.7.115" />
              </ItemGroup>
            </Project>
            """);

        Assert.False(enabled);
    }

    [Fact]
    public void IsEnabled_ReturnsFalse_WhenPropertyExplicitlyFalse()
    {
        using var scratch = new ScratchDirectory();
        string projectDir = Path.Combine(scratch.Path, "src", "App");
        Directory.CreateDirectory(projectDir);

        bool enabled = CentralPackageManagementPolicy.IsEnabled(
            projectDir,
            scratch.Path,
            """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>
              </PropertyGroup>
            </Project>
            """);

        Assert.False(enabled);
    }

    [Fact]
    public void IsEnabled_FallsBackToAncestorDirectoryBuildProps_WhenCentralPackagesFileOmitsProperty()
    {
        using var scratch = new ScratchDirectory();
        string srcDir = Path.Combine(scratch.Path, "src");
        string projectDir = Path.Combine(srcDir, "App");
        Directory.CreateDirectory(projectDir);

        // The property is set in a Directory.Build.props between the project
        // and the Directory.Packages.props directory, not in the CPM file
        // itself (a less common but valid layout).
        File.WriteAllText(
            Path.Combine(srcDir, "Directory.Build.props"),
            """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
            </Project>
            """);

        bool enabled = CentralPackageManagementPolicy.IsEnabled(
            projectDir,
            scratch.Path,
            """
            <Project>
              <ItemGroup>
                <PackageVersion Include="Nerdbank.GitVersioning" Version="3.7.115" />
              </ItemGroup>
            </Project>
            """);

        Assert.True(enabled);
    }

    private sealed class ScratchDirectory : IDisposable
    {
        public ScratchDirectory()
        {
            this.Path = System.IO.Path.Combine(
                AppContext.BaseDirectory, "scratch-projects", "cpm-policy", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            Directory.Delete(this.Path, recursive: true);
        }
    }
}
