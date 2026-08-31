// <copyright file="ReferenceClosure.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace GSharp.Compiler.Tests;

/// <summary>
/// The two reference closures gsc can be driven with, and the helpers that
/// materialise them. Extracted from <c>XunitAssertOverloadResolutionTests</c>
/// (issue #504-reopen) so issue #3717's differential conformance mode can
/// reuse exactly the same closures rather than re-deriving them.
/// <para>
/// The distinction matters because it decides which reflection context gsc
/// binds against. With no <c>/reference:</c> switch gsc resolves imports from
/// the host's trusted platform assemblies and every imported type is a live
/// runtime <see cref="Type"/>; with the <c>Microsoft.NETCore.App.Ref</c>
/// targeting-pack facades gsc constructs a
/// <see cref="System.Reflection.MetadataLoadContext"/> — which is what every
/// real SDK build does. Defects that take the wrong arm of a
/// <c>typeof(X).IsAssignableFrom(clrType)</c> test (#3708, #3697, #3637,
/// #3636, #3666) are visible only in the second configuration.
/// </para>
/// </summary>
internal enum ReferenceClosureMode
{
    /// <summary>
    /// No <c>/reference:</c> switches: gsc falls back to the host's trusted
    /// platform assemblies and imported types are live runtime types.
    /// </summary>
    HostTrustedPlatform,

    /// <summary>
    /// The full <c>Microsoft.NETCore.App.Ref</c> targeting-pack closure passed
    /// via <c>/reference:</c>, as the .NET SDK does — imported types come from
    /// a <see cref="System.Reflection.MetadataLoadContext"/>.
    /// </summary>
    ReferencePack,
}

/// <summary>
/// Resolves the reference closures described by <see cref="ReferenceClosureMode"/>.
/// </summary>
internal static class ReferenceClosure
{
    /// <summary>
    /// Assembles the same reference closure the .NET SDK would pass to gsc —
    /// the <c>Microsoft.NETCore.App.Ref</c> targeting-pack facades for the
    /// running runtime. Each facade resolves to a different
    /// <see cref="System.Reflection.Assembly"/> identity than the host's
    /// <c>System.Private.CoreLib</c>, so imported types are
    /// <c>MetadataLoadContext</c> types rather than runtime types.
    /// </summary>
    /// <returns>The ref-pack reference assemblies.</returns>
    public static IEnumerable<string> RefPackAssemblies()
    {
        string refDir = LocateRefPackDirectory()
            ?? throw new Xunit.Sdk.XunitException(
                "prerequisite missing: " + (UnavailableReason ?? "ref pack not resolvable"));
        return Directory.EnumerateFiles(refDir, "*.dll");
    }

    /// <summary>
    /// The host's trusted platform assemblies — the set gsc falls back to when
    /// no <c>/reference:</c> switch is supplied.
    /// </summary>
    /// <returns>Existing TPA paths.</returns>
    public static IEnumerable<string> TrustedPlatformAssemblies()
    {
        if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is not string tpa
            || string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (string path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }

    /// <summary>
    /// Trusted platform assemblies whose file name starts with
    /// <paramref name="prefix"/>. Used to graft host-resolved packages (for
    /// example xUnit) onto the ref-pack closure; their identity is stable
    /// across both reflection contexts and is not what the differential is
    /// exercising.
    /// </summary>
    /// <param name="prefix">Case-insensitive file-name prefix.</param>
    /// <returns>Matching TPA paths.</returns>
    public static IEnumerable<string> TrustedPlatformAssembliesStartingWith(string prefix)
        => TrustedPlatformAssemblies()
            .Where(path => Path.GetFileName(path)
                .StartsWith(prefix, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Gets a human-readable reason the ref pack could not be located, or
    /// <see langword="null"/> when it was found. Callers that must degrade
    /// gracefully (rather than fail) consult this before enumerating.
    /// </summary>
    public static string UnavailableReason { get; private set; }

    /// <summary>
    /// Gets a value indicating whether the ref pack is present on this machine.
    /// </summary>
    /// <returns><see langword="true"/> when <see cref="RefPackAssemblies"/> will succeed.</returns>
    public static bool IsRefPackAvailable() => LocateRefPackDirectory() is not null;

    private static string LocateRefPackDirectory()
    {
        string runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir))
        {
            return Unavailable("host runtime directory not resolvable");
        }

        string dotnetRoot = Directory.GetParent(runtimeDir)?.Parent?.Parent?.FullName;
        if (string.IsNullOrEmpty(dotnetRoot))
        {
            return Unavailable("dotnet root not resolvable");
        }

        string packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        if (!Directory.Exists(packsRoot))
        {
            return Unavailable($"ref pack root '{packsRoot}' missing");
        }

        string tfm = $"net{Environment.Version.Major}.0";

        // Match the targeting-pack version to the running runtime (e.g. 10.0.X).
        string refDir = Path.Combine(packsRoot, Environment.Version.ToString(3), "ref", tfm);
        if (Directory.Exists(refDir))
        {
            UnavailableReason = null;
            return refDir;
        }

        // Fall back to the newest installed ref pack matching the major version.
        string major = Environment.Version.Major.ToString();
        string candidate = Directory.EnumerateDirectories(packsRoot, major + ".*")
            .OrderByDescending(directory => directory, StringComparer.Ordinal)
            .Select(directory => Path.Combine(directory, "ref", tfm))
            .FirstOrDefault(Directory.Exists);
        if (string.IsNullOrEmpty(candidate))
        {
            return Unavailable($"no ref pack for net{major}.0 under '{packsRoot}'");
        }

        UnavailableReason = null;
        return candidate;
    }

    private static string Unavailable(string reason)
    {
        UnavailableReason = reason;
        return null;
    }
}
