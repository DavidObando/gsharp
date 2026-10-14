// <copyright file="CentralPackageManagementPolicy.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.IO
import System.Text.RegularExpressions

/// Detects whether a migrated app's ancestor `Directory.Packages.props`
/// actually enables NuGet Central Package Management (issue #2319). Merely
/// having a `Directory.Packages.props` file present does not enable CPM —
/// NuGet requires the `ManagePackageVersionsCentrally` MSBuild property to
/// be explicitly set `true`, most commonly inside that same file but
/// occasionally in a shared ancestor `Directory.Build.props` instead. This
/// distinction matters because the `--via-sdk` compile path must never
/// emit a `Version=` attribute on a `PackageReference` it synthesizes
/// when the generated app's copied `Directory.Packages.props` is actually
/// governing versions — NuGet's CPM validation (NU1008) rejects that
/// combination outright.
shared class CentralPackageManagementPolicy {
    private let ManagePackageVersionsCentrallyPattern Regex = Regex(
        "<ManagePackageVersionsCentrally>\\s*(?<value>true|false)\\s*</ManagePackageVersionsCentrally>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled
    )

    /// Determines whether Central Package Management is enabled for a copied
    /// `Directory.Packages.props`.
    /// @param projectDirectory The source project's own directory (the walk starts here).
    /// @param centralPackagesDirectory The directory containing the `Directory.Packages.props` that was
    /// found and copied (the walk stops here, inclusive).
    /// @param centralPackagesFileText The already-read text of that `Directory.Packages.props`.
    /// @returns `true` when `ManagePackageVersionsCentrally` resolves to `true`.
    func IsEnabled(projectDirectory string, centralPackagesDirectory string?, centralPackagesFileText string) bool {
        // The documented, overwhelmingly common location: the property lives
        // directly in Directory.Packages.props alongside the PackageVersion
        // items it governs.
        if TryReadDeclaredValue(centralPackagesFileText, out var declaredInCpmFile) {
            return declaredInCpmFile
        }
        // Fall back to any ancestor Directory.Build.props between the project
        // and the Directory.Packages.props directory (inclusive), closest to
        // the project first, since a shared Directory.Build.props sometimes
        // carries the property instead (e.g. so it can be toggled per-branch
        // alongside other repo-wide build properties).
        var directory string? = projectDirectory
        while !string.IsNullOrEmpty(directory) {
            let candidate = Path.Combine(directory, "Directory.Build.props")
            if File.Exists(candidate) {
                var text string?
                try {
                    text = File.ReadAllText(candidate)
                } catch (ex Exception) when ex is IOException || ex is UnauthorizedAccessException {
                    text = nil
                }
                if text != nil && TryReadDeclaredValue(text, out var declaredInBuildProps) {
                    return declaredInBuildProps
                }
            }
            if string.Equals(
                Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                Path.GetFullPath(centralPackagesDirectory!!).TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar
                ),
                StringComparison.OrdinalIgnoreCase
            ) {
                break
            }
            directory = Directory.GetParent(directory)?.FullName
        }
        return false
    }

    private func TryReadDeclaredValue(msbuildXml string?, out value bool) bool {
        value = false
        if string.IsNullOrEmpty(msbuildXml) {
            return false
        }
        let match = ManagePackageVersionsCentrallyPattern.Match(msbuildXml)
        if !match.Success {
            return false
        }
        value = string.Equals(match.Groups["value"].Value, "true", StringComparison.OrdinalIgnoreCase)
        return true
    }
}
