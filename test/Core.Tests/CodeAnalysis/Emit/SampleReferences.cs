// <copyright file="SampleReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #4665: the explicit reference set the sample-hashing gates compile
/// against. <c>new Compilation(tree)</c> resolves through
/// <c>ReferenceResolver.Default()</c>, which is built from whatever
/// assemblies the test host happens to have loaded, so a G#-built Core or a
/// different host could change name resolution and the AssemblyRef/TypeRef
/// rows. The gates must hash what the compiler emits, not what the host
/// loaded, so they reference the targeting pack (the closure the .NET SDK
/// hands gsc) plus the bundled G# runtime assemblies, exactly as the driver does.
/// </summary>
internal static class SampleReferences
{
    /// <summary>Builds the resolver for a sample compilation.</summary>
    /// <returns>A resolver over the ref pack and the bundled G# runtime assemblies.</returns>
    internal static ReferenceResolver CreateResolver() =>
        ReferenceResolver.WithReferences(ReferenceResolver.ResolveDriverReferencePaths(RefPackAssemblies()));

    /// <summary>The <c>Microsoft.NETCore.App.Ref</c> facades matching the running runtime.</summary>
    /// <returns>The reference assembly paths, sorted.</returns>
    internal static IReadOnlyList<string> RefPackAssemblies()
    {
        string runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)
            ?? throw new InvalidOperationException("The host runtime directory is not resolvable.");
        string dotnetRoot = Directory.GetParent(runtimeDirectory)?.Parent?.Parent?.FullName
            ?? throw new InvalidOperationException("The dotnet root is not resolvable.");
        string packs = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        string major = Environment.Version.Major.ToString();
        string tfm = $"net{major}.0";

        // The exact patch of the running runtime if installed, else the newest
        // pack of the same major version.
        var versions = new List<string> { Environment.Version.ToString(3) };
        if (Directory.Exists(packs))
        {
            versions.AddRange(Directory.EnumerateDirectories(packs, major + ".*")
                .Select(d => Path.GetFileName(d))
                .OrderByDescending(n => ParseVersion(n))
                .ThenByDescending(n => n, StringComparer.Ordinal));
        }

        string? directory = versions
            .Select(version => Path.Combine(packs, version, "ref", tfm))
            .FirstOrDefault(Directory.Exists);
        if (directory is null)
        {
            // A missing prerequisite fails; falling back to the host's loaded
            // assemblies is the dependency this class exists to remove.
            throw new DirectoryNotFoundException(
                $"The Microsoft.NETCore.App.Ref pack for {tfm} was not found under '{packs}'.");
        }

        return Directory.EnumerateFiles(directory, "*.dll").OrderBy(p => p, StringComparer.Ordinal).ToList();
    }

    // Semantic order: "10.0.10" is newer than "10.0.9", which ordinal string
    // order gets backwards. Unparseable names (previews) sort below releases.
    private static Version ParseVersion(string name)
    {
        int dash = name.IndexOf('-');
        string core = dash < 0 ? name : name.Substring(0, dash);
        return Version.TryParse(core, out Version? version) ? version : new Version(0, 0);
    }
}
