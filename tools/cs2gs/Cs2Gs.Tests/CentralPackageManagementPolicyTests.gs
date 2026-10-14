// <copyright file="CentralPackageManagementPolicyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import Xunit

/// Unit tests for (cref:CentralPackageManagementPolicy) (issue #2319):
/// the presence of a `Directory.Packages.props` file does not by itself
/// enable NuGet Central Package Management — the
/// `ManagePackageVersionsCentrally` MSBuild property must resolve
/// `true`, either in that file itself (the documented,
/// overwhelmingly common location) or in a shared ancestor
/// `Directory.Build.props`.
open class CentralPackageManagementPolicyTests {
    @Fact
    func IsEnabled_ReturnsTrue_WhenPropertyDeclaredInCentralPackagesFile() {
        using let scratch = CentralPackageManagementPolicyTests.ScratchDirectory()
        let projectDir = Path.Combine(scratch.Path, "src", "App")
        Directory.CreateDirectory(projectDir)
        let enabled = CentralPackageManagementPolicy.IsEnabled(projectDir, scratch.Path, `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
</Project>`)
        Assert.True(enabled)
    }

    @Fact
    func IsEnabled_ReturnsFalse_WhenCentralPackagesFilePresentButPropertyUnset() {
        using let scratch = CentralPackageManagementPolicyTests.ScratchDirectory()
        let projectDir = Path.Combine(scratch.Path, "src", "App")
        Directory.CreateDirectory(projectDir)
        let enabled = CentralPackageManagementPolicy.IsEnabled(projectDir, scratch.Path, `<Project>
  <ItemGroup>
    <PackageVersion Include="Nerdbank.GitVersioning" Version="3.7.115" />
  </ItemGroup>
</Project>`)
        Assert.False(enabled)
    }

    @Fact
    func IsEnabled_ReturnsFalse_WhenPropertyExplicitlyFalse() {
        using let scratch = CentralPackageManagementPolicyTests.ScratchDirectory()
        let projectDir = Path.Combine(scratch.Path, "src", "App")
        Directory.CreateDirectory(projectDir)
        let enabled = CentralPackageManagementPolicy.IsEnabled(projectDir, scratch.Path, `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>
  </PropertyGroup>
</Project>`)
        Assert.False(enabled)
    }

    @Fact
    func IsEnabled_FallsBackToAncestorDirectoryBuildProps_WhenCentralPackagesFileOmitsProperty() {
        using let scratch = CentralPackageManagementPolicyTests.ScratchDirectory()
        let srcDir = Path.Combine(scratch.Path, "src")
        let projectDir = Path.Combine(srcDir, "App")
        Directory.CreateDirectory(projectDir)
        // The property is set in a Directory.Build.props between the project
        // and the Directory.Packages.props directory, not in the CPM file
        // itself (a less common but valid layout).
        File.WriteAllText(Path.Combine(srcDir, "Directory.Build.props"), `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
</Project>`)
        let enabled = CentralPackageManagementPolicy.IsEnabled(projectDir, scratch.Path, `<Project>
  <ItemGroup>
    <PackageVersion Include="Nerdbank.GitVersioning" Version="3.7.115" />
  </ItemGroup>
</Project>`)
        Assert.True(enabled)
    }

    private class ScratchDirectory : IDisposable {
        init() {
            this.Path = Path.Combine(
                AppContext.BaseDirectory,
                "scratch-projects",
                "cpm-policy",
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
}
