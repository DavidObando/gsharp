// <copyright file="NerdbankGitVersioningPolicy.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Cs2Gs.Translator.Loading;

/// <summary>
/// Policy for the <c>Nerdbank.GitVersioning</c> (nbgv) package during migration
/// (issue #2225). nbgv only generates the <c>ThisAssembly</c> source for the
/// languages its MSBuild <c>&lt;Language&gt;</c> switch supports; G# support first
/// shipped in <c>3.11.13-beta</c>. A C# project that references an older nbgv will,
/// once migrated to G#, silently fail to produce <c>ThisAssembly</c>. cs2gs
/// therefore bumps a below-floor nbgv reference up to the minimum G#-capable
/// version when it can do so safely (a plain literal version — never an MSBuild
/// property, floating range, or wildcard).
/// </summary>
public static class NerdbankGitVersioningPolicy
{
    /// <summary>The nbgv package id, matched case-insensitively.</summary>
    public const string PackageId = "Nerdbank.GitVersioning";

    /// <summary>
    /// The lowest nbgv version that emits the G# <c>ThisAssembly</c> source.
    /// A below-floor literal reference is bumped up to exactly this value.
    /// </summary>
    public const string MinimumGSharpVersion = "3.11.13-beta";

    private static readonly SemVer Floor = SemVer.Parse(MinimumGSharpVersion);

    // Element with an Include attribute referencing the nbgv package (either a
    // <PackageReference> in the project / Directory.Build.props or a
    // <PackageVersion> in a Central Package Management Directory.Packages.props).
    private static readonly Regex NbgvElementPattern = new Regex(
        "<(?<tag>PackageReference|PackageVersion)\\b(?<attrs>[^>]*?Include\\s*=\\s*\"Nerdbank\\.GitVersioning\"[^>]*?)(?<slash>/?)>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex VersionAttrPattern = new Regex(
        "(?<pre>Version\\s*=\\s*\")(?<value>[^\"]*)(?<post>\")",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex PrivateAssetsAttrPattern = new Regex(
        "PrivateAssets\\s*=\\s*\"(?<value>[^\"]*)\"",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex IncludeAssetsAttrPattern = new Regex(
        "IncludeAssets\\s*=\\s*\"(?<value>[^\"]*)\"",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>
    /// Scans a single MSBuild file's text for an nbgv <c>PackageReference</c> or
    /// <c>PackageVersion</c> declaration (issue #2267). Central Package Management
    /// commonly splits the declaration across two files: a versionless
    /// <c>&lt;PackageReference Include="Nerdbank.GitVersioning" PrivateAssets="all" /&gt;</c>
    /// in the consuming project (or a shared <c>Directory.Build.props</c>) and the
    /// actual <c>&lt;PackageVersion Include="Nerdbank.GitVersioning" Version="..." /&gt;</c>
    /// in <c>Directory.Packages.props</c> — so this only reports whichever pieces
    /// this particular file's text contributes; callers combine results across the
    /// full candidate file set to recover the complete declaration.
    /// </summary>
    /// <param name="msbuildXml">The full text of a <c>.csproj</c>/<c>.props</c> file.</param>
    /// <param name="version">Receives the raw <c>Version</c> attribute value, or <see langword="null"/> when absent.</param>
    /// <param name="privateAssets">Receives the raw <c>PrivateAssets</c> attribute value, or <see langword="null"/> when absent.</param>
    /// <param name="includeAssets">Receives the raw <c>IncludeAssets</c> attribute value, or <see langword="null"/> when absent.</param>
    /// <returns><see langword="true"/> when an nbgv element was found in this file.</returns>
    public static bool TryFindDeclaration(string msbuildXml, out string version, out string privateAssets, out string includeAssets)
    {
        version = null;
        privateAssets = null;
        includeAssets = null;
        if (string.IsNullOrEmpty(msbuildXml))
        {
            return false;
        }

        bool found = false;
        foreach (Match match in NbgvElementPattern.Matches(msbuildXml))
        {
            found = true;
            string attrs = match.Groups["attrs"].Value;

            Match versionMatch = VersionAttrPattern.Match(attrs);
            if (versionMatch.Success && version is null)
            {
                version = versionMatch.Groups["value"].Value;
            }

            // PrivateAssets/IncludeAssets are consumer-side attributes: they only
            // ever appear on a <PackageReference>, never on the CPM <PackageVersion>.
            if (string.Equals(match.Groups["tag"].Value, "PackageReference", StringComparison.OrdinalIgnoreCase))
            {
                if (privateAssets is null)
                {
                    Match privateAssetsMatch = PrivateAssetsAttrPattern.Match(attrs);
                    if (privateAssetsMatch.Success)
                    {
                        privateAssets = privateAssetsMatch.Groups["value"].Value;
                    }
                }

                if (includeAssets is null)
                {
                    Match includeAssetsMatch = IncludeAssetsAttrPattern.Match(attrs);
                    if (includeAssetsMatch.Success)
                    {
                        includeAssets = includeAssetsMatch.Groups["value"].Value;
                    }
                }
            }
        }

        return found;
    }

    /// <summary>
    /// Resolves the concrete nbgv version to declare in a rebuilt/isolated
    /// project (issue #2267) from a raw declared version that may come from a
    /// different MSBuild evaluation context (e.g. a CPM
    /// <c>Directory.Packages.props</c> not present alongside an isolated
    /// gsproj). A below-floor literal is bumped to <see cref="MinimumGSharpVersion"/>
    /// (mirrors <see cref="TryGetRequiredBump"/>); an at-or-above-floor literal is
    /// preserved as-is; anything else (missing, an MSBuild property, a range, or a
    /// wildcard — none of which resolve outside their original context) falls back
    /// to <see cref="MinimumGSharpVersion"/>, the lowest version known to work.
    /// </summary>
    /// <param name="rawVersion">The raw declared <c>Version</c> attribute value, or <see langword="null"/>.</param>
    /// <returns>The concrete version to declare.</returns>
    public static string ResolveEffectiveVersion(string rawVersion)
    {
        if (TryGetRequiredBump(rawVersion, out string bumped))
        {
            return bumped;
        }

        if (IsPlainLiteral(rawVersion) && SemVer.TryParse(rawVersion.Trim(), out _))
        {
            return rawVersion.Trim();
        }

        return MinimumGSharpVersion;
    }

    /// <summary>
    /// Determines whether the supplied version string denotes an nbgv version
    /// strictly below <see cref="MinimumGSharpVersion"/> that can be safely
    /// bumped. A version is bumpable only when it is a plain semantic-version
    /// literal; a version carrying an MSBuild property (<c>$(...)</c>), a
    /// floating/wildcard (<c>*</c>), or a version range (<c>[..]</c>/<c>(..)</c>)
    /// is left untouched ("if possible").
    /// </summary>
    /// <param name="version">The raw <c>Version</c> attribute value.</param>
    /// <param name="bumpedVersion">
    /// Receives <see cref="MinimumGSharpVersion"/> when a bump is warranted;
    /// otherwise <see langword="null"/>.
    /// </param>
    /// <returns><see langword="true"/> when a bump should be applied.</returns>
    public static bool TryGetRequiredBump(string version, out string bumpedVersion)
    {
        bumpedVersion = null;

        // Not a plain literal — an MSBuild property, floating version, or range.
        // We cannot know its resolved value, so leave it as-is.
        if (!IsPlainLiteral(version))
        {
            return false;
        }

        if (!SemVer.TryParse(version.Trim(), out SemVer current))
        {
            return false;
        }

        if (SemVer.Compare(current, Floor) < 0)
        {
            bumpedVersion = MinimumGSharpVersion;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Rewrites an MSBuild file's XML so any below-floor literal nbgv version is
    /// bumped to <see cref="MinimumGSharpVersion"/>. Only the version attribute
    /// value is edited; the surrounding formatting, comments, and unrelated items
    /// are preserved. A version-less nbgv reference (the CPM consumer side) is
    /// left unchanged — the version lives in <c>Directory.Packages.props</c>.
    /// </summary>
    /// <param name="msbuildXml">The full text of a <c>.csproj</c>/<c>.props</c> file.</param>
    /// <param name="rewrittenXml">Receives the bumped text when a change was made.</param>
    /// <returns><see langword="true"/> when the text was changed.</returns>
    public static bool TryBumpProjectXml(string msbuildXml, out string rewrittenXml)
    {
        rewrittenXml = null;
        if (string.IsNullOrEmpty(msbuildXml))
        {
            return false;
        }

        bool changed = false;
        string result = NbgvElementPattern.Replace(msbuildXml, element =>
        {
            string attrs = element.Groups["attrs"].Value;
            Match versionMatch = VersionAttrPattern.Match(attrs);
            if (!versionMatch.Success)
            {
                return element.Value;
            }

            string currentVersion = versionMatch.Groups["value"].Value;
            if (!TryGetRequiredBump(currentVersion, out string bumped))
            {
                return element.Value;
            }

            string newAttrs = attrs.Substring(0, versionMatch.Index)
                + versionMatch.Groups["pre"].Value
                + bumped
                + versionMatch.Groups["post"].Value
                + attrs.Substring(versionMatch.Index + versionMatch.Length);

            changed = true;
            return "<" + element.Groups["tag"].Value + newAttrs + element.Groups["slash"].Value + ">";
        });

        if (changed)
        {
            rewrittenXml = result;
        }

        return changed;
    }

    /// <summary>
    /// Determines whether <paramref name="version"/> is a plain semantic-version
    /// literal cs2gs can reason about outside its original MSBuild evaluation
    /// context — i.e. not an MSBuild property (<c>$(...)</c>), a floating/wildcard
    /// (<c>*</c>), or a version range (<c>[..]</c>/<c>(..)</c>).
    /// </summary>
    /// <param name="version">The raw <c>Version</c> attribute value.</param>
    /// <returns><see langword="true"/> when the value is a plain literal.</returns>
    private static bool IsPlainLiteral(string version)
    {
        if (string.IsNullOrWhiteSpace(version))
        {
            return false;
        }

        string trimmed = version.Trim();
        return trimmed.IndexOf("$(", StringComparison.Ordinal) < 0 &&
            trimmed.IndexOf('*') < 0 &&
            trimmed.IndexOf('[') < 0 &&
            trimmed.IndexOf('(') < 0 &&
            trimmed.IndexOf(',') < 0;
    }

    /// <summary>
    /// A minimal semantic-version value (numeric release plus an optional
    /// dot-separated prerelease), compared per the SemVer 2.0.0 precedence rules.
    /// Build metadata (<c>+...</c>) is ignored. Missing minor/patch segments are
    /// treated as zero so <c>3.11</c> equals <c>3.11.0</c>.
    /// </summary>
    private readonly struct SemVer
    {
        private readonly int major;
        private readonly int minor;
        private readonly int patch;
        private readonly string[] prerelease;

        private SemVer(int major, int minor, int patch, string[] prerelease)
        {
            this.major = major;
            this.minor = minor;
            this.patch = patch;
            this.prerelease = prerelease;
        }

        public static SemVer Parse(string value)
        {
            if (!TryParse(value, out SemVer result))
            {
                throw new FormatException($"Invalid semantic version: '{value}'.");
            }

            return result;
        }

        public static bool TryParse(string value, out SemVer result)
        {
            result = default;
            if (string.IsNullOrWhiteSpace(value))
            {
                return false;
            }

            string core = value.Trim();

            // Drop build metadata.
            int plus = core.IndexOf('+');
            if (plus >= 0)
            {
                core = core.Substring(0, plus);
            }

            string[] prerelease = Array.Empty<string>();
            int dash = core.IndexOf('-');
            if (dash >= 0)
            {
                string pre = core.Substring(dash + 1);
                core = core.Substring(0, dash);
                if (pre.Length == 0)
                {
                    return false;
                }

                prerelease = pre.Split('.');
            }

            string[] parts = core.Split('.');
            if (parts.Length == 0 || parts.Length > 3)
            {
                return false;
            }

            int[] numbers = new int[3];
            for (int i = 0; i < parts.Length; i++)
            {
                if (!int.TryParse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture, out numbers[i]))
                {
                    return false;
                }
            }

            result = new SemVer(numbers[0], numbers[1], numbers[2], prerelease);
            return true;
        }

        public static int Compare(SemVer a, SemVer b)
        {
            int cmp = a.major.CompareTo(b.major);
            if (cmp != 0)
            {
                return cmp;
            }

            cmp = a.minor.CompareTo(b.minor);
            if (cmp != 0)
            {
                return cmp;
            }

            cmp = a.patch.CompareTo(b.patch);
            if (cmp != 0)
            {
                return cmp;
            }

            // A version with a prerelease has LOWER precedence than the
            // associated stable release (SemVer 2.0.0 §11).
            bool aHasPre = a.prerelease.Length > 0;
            bool bHasPre = b.prerelease.Length > 0;
            if (!aHasPre && !bHasPre)
            {
                return 0;
            }

            if (!aHasPre)
            {
                return 1;
            }

            if (!bHasPre)
            {
                return -1;
            }

            return ComparePrerelease(a.prerelease, b.prerelease);
        }

        private static int ComparePrerelease(string[] a, string[] b)
        {
            int count = Math.Min(a.Length, b.Length);
            for (int i = 0; i < count; i++)
            {
                bool aNum = int.TryParse(a[i], NumberStyles.None, CultureInfo.InvariantCulture, out int an);
                bool bNum = int.TryParse(b[i], NumberStyles.None, CultureInfo.InvariantCulture, out int bn);

                if (aNum && bNum)
                {
                    int cmp = an.CompareTo(bn);
                    if (cmp != 0)
                    {
                        return cmp;
                    }
                }
                else if (aNum)
                {
                    // Numeric identifiers have lower precedence than alphanumeric.
                    return -1;
                }
                else if (bNum)
                {
                    return 1;
                }
                else
                {
                    int cmp = string.CompareOrdinal(a[i], b[i]);
                    if (cmp != 0)
                    {
                        return cmp;
                    }
                }
            }

            // A larger set of prerelease fields has higher precedence when all
            // preceding identifiers are equal.
            return a.Length.CompareTo(b.Length);
        }
    }
}
