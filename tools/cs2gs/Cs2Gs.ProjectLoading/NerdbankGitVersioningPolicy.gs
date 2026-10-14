// <copyright file="NerdbankGitVersioningPolicy.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Loading

import System
import System.Globalization
import System.Text.RegularExpressions

/// Policy for the `Nerdbank.GitVersioning` (nbgv) package during migration
/// (issue #2225). nbgv only generates the `ThisAssembly` source for the
/// languages its MSBuild `<Language>` switch supports; G# support first
/// shipped in `3.11.13-beta`. A C# project that references an older nbgv will,
/// once migrated to G#, silently fail to produce `ThisAssembly`. cs2gs
/// therefore bumps a below-floor nbgv reference up to the minimum G#-capable
/// version when it can do so safely (a plain literal version — never an MSBuild
/// property, floating range, or wildcard).
shared class NerdbankGitVersioningPolicy {
    /// A minimal semantic-version value (numeric release plus an optional
    /// dot-separated prerelease), compared per the SemVer 2.0.0 precedence rules.
    /// Build metadata (`+...`) is ignored. Missing minor/patch segments are
    /// treated as zero so `3.11` equals `3.11.0`.
    private struct SemVer {
        private let major int32
        private let minor int32
        private let patch int32
        private let prerelease[]string

        private init(major int32, minor int32, patch int32, prerelease[]string) {
            this.major = major
            this.minor = minor
            this.patch = patch
            this.prerelease = prerelease
        }

        shared {
            func Parse(value string) SemVer {
                if !TryParse(value, out var result) {
                    throw FormatException("Invalid semantic version: '$value'.")
                }
                return result
            }

            func TryParse(value string, out result SemVer) bool {
                result = default(SemVer)
                if string.IsNullOrWhiteSpace(value) {
                    return false
                }
                var core = value.Trim()
                // Drop build metadata.
                let plus = core.IndexOf('+')
                if plus >= 0 {
                    core = core.Substring(0, plus)
                }
                var prerelease = Array.Empty[string]()
                let dash = core.IndexOf('-')
                if dash >= 0 {
                    let pre = core.Substring(dash + 1)
                    core = core.Substring(0, dash)
                    if pre.Length == 0 {
                        return false
                    }
                    prerelease = pre.Split('.')
                }
                let parts = core.Split('.')
                if parts.Length == 0 || parts.Length > 3 {
                    return false
                }
                let numbers = [3]int32
                for var i = 0; i < parts.Length; i++ {
                    if !int32.TryParse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture, &numbers[i]) {
                        return false
                    }
                }
                result = SemVer(numbers[0], numbers[1], numbers[2], prerelease)
                return true
            }

            func Compare(a SemVer, b SemVer) int32 {
                var cmp = a.major.CompareTo(b.major)
                if cmp != 0 {
                    return cmp
                }
                cmp = a.minor.CompareTo(b.minor)
                if cmp != 0 {
                    return cmp
                }
                cmp = a.patch.CompareTo(b.patch)
                if cmp != 0 {
                    return cmp
                }
                // A version with a prerelease has LOWER precedence than the
                // associated stable release (SemVer 2.0.0 §11).
                let aHasPre = a.prerelease.Length > 0
                let bHasPre = b.prerelease.Length > 0
                if !aHasPre && !bHasPre {
                    return 0
                }
                if !aHasPre {
                    return 1
                }
                if !bHasPre {
                    return -1
                }
                return ComparePrerelease(a.prerelease, b.prerelease)
            }

            private func ComparePrerelease(a[]string, b[]string) int32 {
                let count = Math.Min(a.Length, b.Length)
                for var i = 0; i < count; i++ {
                    let aNum = int32.TryParse(a[i], NumberStyles.None, CultureInfo.InvariantCulture, out var an)
                    let bNum = int32.TryParse(b[i], NumberStyles.None, CultureInfo.InvariantCulture, out var bn)
                    if aNum && bNum {
                        let cmp = an.CompareTo(bn)
                        if cmp != 0 {
                            return cmp
                        }
                    } else if aNum {
                        // Numeric identifiers have lower precedence than alphanumeric.
                        return -1
                    } else if bNum {
                        return 1
                    } else {
                        let cmp = string.CompareOrdinal(a[i], b[i])
                        if cmp != 0 {
                            return cmp
                        }
                    }
                }
                // A larger set of prerelease fields has higher precedence when all
                // preceding identifiers are equal.
                return a.Length.CompareTo(b.Length)
            }
        }
    }

    /// The nbgv package id, matched case-insensitively.
    const PackageId string = "Nerdbank.GitVersioning"

    /// The lowest nbgv version that emits the G# `ThisAssembly` source.
    /// A below-floor literal reference is bumped up to exactly this value.
    const MinimumGSharpVersion string = "3.11.13-beta"

    private let Floor SemVer = SemVer.Parse(MinimumGSharpVersion)

    // Element with an Include attribute referencing the nbgv package (either a
    // <PackageReference> in the project / Directory.Build.props or a
    // <PackageVersion> in a Central Package Management Directory.Packages.props).
    private let NbgvElementPattern Regex = Regex(
        "<(?<tag>PackageReference|PackageVersion)\\b(?<attrs>[^>]*?Include\\s*=\\s*\"Nerdbank\\.GitVersioning\"[^>]*?)(?<slash>/?)>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled
    )

    private let VersionAttrPattern Regex = Regex(
        "(?<pre>Version\\s*=\\s*\")(?<value>[^\"]*)(?<post>\")",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled
    )
    private let PrivateAssetsAttrPattern Regex = Regex(
        "PrivateAssets\\s*=\\s*\"(?<value>[^\"]*)\"",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled
    )
    private let IncludeAssetsAttrPattern Regex = Regex(
        "IncludeAssets\\s*=\\s*\"(?<value>[^\"]*)\"",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled
    )

    /// Scans a single MSBuild file's text for an nbgv `PackageReference` or
    /// `PackageVersion` declaration (issue #2267). Central Package Management
    /// commonly splits the declaration across two files: a versionless
    /// `<PackageReference Include="Nerdbank.GitVersioning" PrivateAssets="all" />`
    /// in the consuming project (or a shared `Directory.Build.props`) and the
    /// actual `<PackageVersion Include="Nerdbank.GitVersioning" Version="..." />`
    /// in `Directory.Packages.props` — so this only reports whichever pieces
    /// this particular file's text contributes; callers combine results across the
    /// full candidate file set to recover the complete declaration.
    /// @param msbuildXml The full text of a `.csproj`/`.props` file.
    /// @param version Receives the raw `Version` attribute value, or `null` when absent.
    /// @param privateAssets Receives the raw `PrivateAssets` attribute value, or `null` when absent.
    /// @param includeAssets Receives the raw `IncludeAssets` attribute value, or `null` when absent.
    /// @returns `true` when an nbgv element was found in this file.
    func TryFindDeclaration(
        msbuildXml string,
        out version string?,
        out privateAssets string?,
        out includeAssets string?
    ) bool {
        version = nil
        privateAssets = nil
        includeAssets = nil
        if string.IsNullOrEmpty(msbuildXml) {
            return false
        }
        var found = false
        for match Match in NbgvElementPattern.Matches(msbuildXml) {
            found = true
            let attrs = match.Groups["attrs"].Value
            let versionMatch = VersionAttrPattern.Match(attrs)
            if versionMatch.Success && version == nil {
                version = versionMatch.Groups["value"].Value
            }
            // PrivateAssets/IncludeAssets are consumer-side attributes: they only
            // ever appear on a <PackageReference>, never on the CPM <PackageVersion>.
            if string.Equals(match.Groups["tag"].Value, "PackageReference", StringComparison.OrdinalIgnoreCase) {
                if privateAssets == nil {
                    let privateAssetsMatch = PrivateAssetsAttrPattern.Match(attrs)
                    if privateAssetsMatch.Success {
                        privateAssets = privateAssetsMatch.Groups["value"].Value
                    }
                }
                if includeAssets == nil {
                    let includeAssetsMatch = IncludeAssetsAttrPattern.Match(attrs)
                    if includeAssetsMatch.Success {
                        includeAssets = includeAssetsMatch.Groups["value"].Value
                    }
                }
            }
        }
        return found
    }

    /// Resolves the concrete nbgv version to declare in a rebuilt/isolated
    /// project (issue #2267) from a raw declared version that may come from a
    /// different MSBuild evaluation context (e.g. a CPM
    /// `Directory.Packages.props` not present alongside an isolated
    /// gsproj). A below-floor literal is bumped to (cref:MinimumGSharpVersion)
    /// (mirrors (cref:TryGetRequiredBump)); an at-or-above-floor literal is
    /// preserved as-is; anything else (missing, an MSBuild property, a range, or a
    /// wildcard — none of which resolve outside their original context) falls back
    /// to (cref:MinimumGSharpVersion), the lowest version known to work.
    /// @param rawVersion The raw declared `Version` attribute value, or `null`.
    /// @returns The concrete version to declare.
    func ResolveEffectiveVersion(rawVersion string) string? {
        if TryGetRequiredBump(rawVersion, out var bumped) {
            return bumped
        }
        if IsPlainLiteral(rawVersion) && SemVer.TryParse(rawVersion.Trim(), out _) {
            return rawVersion.Trim()
        }
        return MinimumGSharpVersion
    }

    /// Determines whether the supplied version string denotes an nbgv version
    /// strictly below (cref:MinimumGSharpVersion) that can be safely
    /// bumped. A version is bumpable only when it is a plain semantic-version
    /// literal; a version carrying an MSBuild property (`$(...)`), a
    /// floating/wildcard (`*`), or a version range (`[..]`/`(..)`)
    /// is left untouched ("if possible").
    /// @param version The raw `Version` attribute value.
    /// @param bumpedVersion Receives (cref:MinimumGSharpVersion) when a bump is warranted;
    /// otherwise `null`.
    /// @returns `true` when a bump should be applied.
    func TryGetRequiredBump(version string, out bumpedVersion string?) bool {
        bumpedVersion = nil
        // Not a plain literal — an MSBuild property, floating version, or range.
        // We cannot know its resolved value, so leave it as-is.
        if !IsPlainLiteral(version) {
            return false
        }
        if !SemVer.TryParse(version.Trim(), out var current) {
            return false
        }
        if SemVer.Compare(current, Floor) < 0 {
            bumpedVersion = MinimumGSharpVersion
            return true
        }
        return false
    }

    /// Rewrites an MSBuild file's XML so any below-floor literal nbgv version is
    /// bumped to (cref:MinimumGSharpVersion). Only the version attribute
    /// value is edited; the surrounding formatting, comments, and unrelated items
    /// are preserved. A version-less nbgv reference (the CPM consumer side) is
    /// left unchanged — the version lives in `Directory.Packages.props`.
    /// @param msbuildXml The full text of a `.csproj`/`.props` file.
    /// @param rewrittenXml Receives the bumped text when a change was made.
    /// @returns `true` when the text was changed.
    func TryBumpProjectXml(msbuildXml string, out rewrittenXml string?) bool {
        rewrittenXml = nil
        if string.IsNullOrEmpty(msbuildXml) {
            return false
        }
        var changed = false
        let result = NbgvElementPattern.Replace(
            msbuildXml,
            func (element Match) string {
                let attrs = element.Groups["attrs"].Value
                let versionMatch = VersionAttrPattern.Match(attrs)
                if !versionMatch.Success {
                    return element.Value
                }
                let currentVersion = versionMatch.Groups["value"].Value
                if !TryGetRequiredBump(currentVersion, out var bumped) {
                    return element.Value
                }
                let newAttrs = attrs.Substring(0, versionMatch.Index) +
                    versionMatch
                    .Groups["pre"]
                    .Value +
                    bumped +
                    versionMatch
                    .Groups["post"]
                    .Value +
                    attrs.Substring(versionMatch.Index + versionMatch.Length)
                changed = true
                return "<" + element.Groups["tag"].Value + newAttrs + element.Groups["slash"].Value + ">"
            }
        )
        if changed {
            rewrittenXml = result
        }
        return changed
    }

    /// Determines whether [`version`](paramref) is a plain semantic-version
    /// literal cs2gs can reason about outside its original MSBuild evaluation
    /// context — i.e. not an MSBuild property (`$(...)`), a floating/wildcard
    /// (`*`), or a version range (`[..]`/`(..)`).
    /// @param version The raw `Version` attribute value.
    /// @returns `true` when the value is a plain literal.
    private func IsPlainLiteral(version string) bool {
        if string.IsNullOrWhiteSpace(version) {
            return false
        }
        let trimmed = version.Trim()
        return trimmed.IndexOf("$$(", StringComparison.Ordinal) < 0 && trimmed.IndexOf('*') < 0 && trimmed.IndexOf(
            '['
        ) < 0 &&
            trimmed.IndexOf('(') < 0 && trimmed.IndexOf(',') < 0
    }
}
