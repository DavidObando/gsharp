// <copyright file="CentralPackageManagementPolicy.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Text.RegularExpressions;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Detects whether a migrated app's ancestor <c>Directory.Packages.props</c>
/// actually enables NuGet Central Package Management (issue #2319). Merely
/// having a <c>Directory.Packages.props</c> file present does not enable CPM —
/// NuGet requires the <c>ManagePackageVersionsCentrally</c> MSBuild property to
/// be explicitly set <c>true</c>, most commonly inside that same file but
/// occasionally in a shared ancestor <c>Directory.Build.props</c> instead. This
/// distinction matters because the <c>--via-sdk</c> compile path must never
/// emit a <c>Version=</c> attribute on a <c>PackageReference</c> it synthesizes
/// when the generated app's copied <c>Directory.Packages.props</c> is actually
/// governing versions — NuGet's CPM validation (NU1008) rejects that
/// combination outright.
/// </summary>
public static class CentralPackageManagementPolicy
{
    private static readonly Regex ManagePackageVersionsCentrallyPattern = new Regex(
        "<ManagePackageVersionsCentrally>\\s*(?<value>true|false)\\s*</ManagePackageVersionsCentrally>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>
    /// Determines whether Central Package Management is enabled for a copied
    /// <c>Directory.Packages.props</c>.
    /// </summary>
    /// <param name="projectDirectory">The source project's own directory (the walk starts here).</param>
    /// <param name="centralPackagesDirectory">
    /// The directory containing the <c>Directory.Packages.props</c> that was
    /// found and copied (the walk stops here, inclusive).
    /// </param>
    /// <param name="centralPackagesFileText">The already-read text of that <c>Directory.Packages.props</c>.</param>
    /// <returns><see langword="true"/> when <c>ManagePackageVersionsCentrally</c> resolves to <c>true</c>.</returns>
    public static bool IsEnabled(
        string projectDirectory,
        string centralPackagesDirectory,
        string centralPackagesFileText)
    {
        // The documented, overwhelmingly common location: the property lives
        // directly in Directory.Packages.props alongside the PackageVersion
        // items it governs.
        if (TryReadDeclaredValue(centralPackagesFileText, out bool declaredInCpmFile))
        {
            return declaredInCpmFile;
        }

        // Fall back to any ancestor Directory.Build.props between the project
        // and the Directory.Packages.props directory (inclusive), closest to
        // the project first, since a shared Directory.Build.props sometimes
        // carries the property instead (e.g. so it can be toggled per-branch
        // alongside other repo-wide build properties).
        string directory = projectDirectory;
        while (!string.IsNullOrEmpty(directory))
        {
            string candidate = Path.Combine(directory, "Directory.Build.props");
            if (File.Exists(candidate))
            {
                string text;
                try
                {
                    text = File.ReadAllText(candidate);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    text = null;
                }

                if (text is not null && TryReadDeclaredValue(text, out bool declaredInBuildProps))
                {
                    return declaredInBuildProps;
                }
            }

            if (string.Equals(
                Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                Path.GetFullPath(centralPackagesDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase))
            {
                break;
            }

            directory = Directory.GetParent(directory)?.FullName;
        }

        return false;
    }

    private static bool TryReadDeclaredValue(string msbuildXml, out bool value)
    {
        value = false;
        if (string.IsNullOrEmpty(msbuildXml))
        {
            return false;
        }

        Match match = ManagePackageVersionsCentrallyPattern.Match(msbuildXml);
        if (!match.Success)
        {
            return false;
        }

        value = string.Equals(match.Groups["value"].Value, "true", StringComparison.OrdinalIgnoreCase);
        return true;
    }
}
