// <copyright file="Issue3394LocalSdkPackageSelectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import Xunit

/// Issue #3394: local migration builds must use the package produced by the
/// latest build, even when an older branch left a higher semantic version.
open class Issue3394LocalSdkPackageSelectionTests {
    @Fact
    func ResolveLocalSdkPackage_PrefersNewestBuildOverHigherVersion() {
        let root = CreateTestRoot()
        let packages = Path.Combine(root, "out", "bin", "Release", "nupkgs")
        Directory.CreateDirectory(packages)
        try {
            let stale = Path.Combine(packages, "Gsharp.NET.Sdk.9.0.0-gstale.nupkg")
            let current = Path.Combine(packages, "Gsharp.NET.Sdk.1.0.0-gcurrent.nupkg")
            File.WriteAllBytes(stale, Array.Empty[uint8]())
            File.WriteAllBytes(current, Array.Empty[uint8]())
            File.SetLastWriteTimeUtc(stale, DateTime.UtcNow.AddMinutes(-1))
            File.SetLastWriteTimeUtc(current, DateTime.UtcNow)
            let resolved = GsharpTestProjectRunner.ResolveLocalSdkPackage(root)
            Assert.NotNull(resolved)
            Assert.Equal(current, resolved!!.NupkgPath)
            Assert.Equal("1.0.0-gcurrent", resolved!!.Version)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func ResolveLocalSdkPackage_WhenWriteTimesTie_PrefersHigherVersion() {
        let root = CreateTestRoot()
        let packages = Path.Combine(root, "out", "bin", "Release", "nupkgs")
        Directory.CreateDirectory(packages)
        try {
            AssertTiedPackageWins(
                packages,
                "9.0.0-glower",
                "10.0.0-ghigher",
                "10.0.0-ghigher",
                func ()(NupkgPath string, Version string)? {
                    return GsharpTestProjectRunner.ResolveLocalSdkPackage(root)
                }
            )
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func ResolveNewestSdkPackage_WhenVersionsAndWriteTimesTie_UsesOrdinalPackageName() {
        let root = CreateTestRoot()
        let packages = Path.Combine(root, ".nugs")
        Directory.CreateDirectory(packages)
        try {
            Assert.Equal(0, GsharpTestProjectRunner.CompareVersions("1.0", "1.0.0"))
            AssertTiedPackageWins(
                packages,
                "1.0",
                "1.0.0",
                "1.0",
                func ()(NupkgPath string, Version string)? {
                    return GsharpTestProjectRunner.ResolveNewestSdkPackage(packages)
                }
            )
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        private func CreateTestRoot() string -> Path.Combine(
            AppContext.BaseDirectory,
            "sdk-selection-tests",
            Guid.NewGuid().ToString("N")
        )

        private func AssertTiedPackageWins(
            packages string,
            firstVersion string,
            secondVersion string,
            expectedVersion string,
            resolve() -> (NupkgPath string, Version string)?
        ) {
            let first = Path.Combine(packages, "Gsharp.NET.Sdk.$firstVersion.nupkg")
            let second = Path.Combine(packages, "Gsharp.NET.Sdk.$secondVersion.nupkg")
            let expected = Path.Combine(packages, "Gsharp.NET.Sdk.$expectedVersion.nupkg")
            File.WriteAllBytes(first, Array.Empty[uint8]())
            File.WriteAllBytes(second, Array.Empty[uint8]())
            let tiedWriteTime = DateTime(2020, 1, 2, 3, 4, 5, DateTimeKind.Utc)
            File.SetLastWriteTimeUtc(first, tiedWriteTime)
            File.SetLastWriteTimeUtc(second, tiedWriteTime)
            Assert.Equal(File.GetLastWriteTimeUtc(first), File.GetLastWriteTimeUtc(second))
            let resolved = resolve()
            Assert.NotNull(resolved)
            Assert.Equal(expected, resolved!!.NupkgPath)
            Assert.Equal(expectedVersion, resolved!!.Version)
        }
    }
}
