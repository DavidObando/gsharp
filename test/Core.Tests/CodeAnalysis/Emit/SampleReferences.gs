// <copyright file="SampleReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.IO
import System.Linq

/// Issue #4665: the explicit reference set the sample-hashing gates compile
/// against. `new Compilation(tree)` resolves through
/// `ReferenceResolver.Default()`, which is built from whatever
/// assemblies the test host happens to have loaded, so a G#-built Core or a
/// different host could change name resolution and the AssemblyRef/TypeRef
/// rows. The gates must hash what the compiler emits, not what the host
/// loaded, so they reference the targeting pack (the closure the .NET SDK
/// hands gsc) plus the bundled G# runtime assemblies, exactly as the driver does.
internal shared class SampleReferences {
    /// Builds the resolver for a sample compilation.
    /// @returns A resolver over the ref pack and the bundled G# runtime assemblies.
    internal func CreateResolver() ReferenceResolver -> ReferenceResolver.WithReferences(
        ReferenceResolver.ResolveDriverReferencePaths(RefPackAssemblies())
    )

    /// The `Microsoft.NETCore.App.Ref` facades matching the running runtime.
    /// @returns The reference assembly paths, sorted.
    internal func RefPackAssemblies() IReadOnlyList[string] {
        let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location) ??
            throw InvalidOperationException("The host runtime directory is not resolvable.")
        let dotnetRoot = Directory
            .GetParent(runtimeDirectory)
            ?.Parent
            ?.Parent
            ?.FullName ??
            throw InvalidOperationException("The dotnet root is not resolvable.")
        let packs = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
        let major = Environment.Version.Major.ToString()
        let tfm = "net$major.0"
        // The exact patch of the running runtime if installed, else the newest
        // pack of the same major version.
        let versions = List[string]{Environment.Version.ToString(3)}
        if Directory.Exists(packs) {
            versions.AddRange(
                Directory
                    .EnumerateDirectories(packs, major + ".*")
                    .Select((d string) -> Path.GetFileName(d))
                    .OrderByDescending((n string) -> ParseVersion(n))
                    .ThenByDescending((n string) -> !n.Contains('-'))
                    .ThenByDescending((n string) -> n, StringComparer.Ordinal)
            )
        }
        let directory string? = versions.Select((version string) -> Path.Combine(packs, version, "ref", tfm))
            .FirstOrDefault(Directory.Exists)
        if directory == nil {
            // A missing prerequisite fails; falling back to the host's loaded
            // assemblies is the dependency this class exists to remove.
            throw DirectoryNotFoundException(
                "The Microsoft.NETCore.App.Ref pack for $tfm was not found under '$packs'."
            )
        }
        return Directory.EnumerateFiles(directory, "*.dll").OrderBy((p string) -> p, StringComparer.Ordinal).ToList()
    }

    // Semantic order: "10.0.10" is newer than "10.0.9", which ordinal string
    // order gets backwards. Unparseable names (previews) sort below releases.
    private func ParseVersion(name string) Version {
        let dash = name.IndexOf('-')
        let core = if dash < 0 {
            name
        } else {
            name.Substring(0, dash)
        }
        return if Version.TryParse(core, out var version) {
            version
        } else {
            Version(0, 0)
        }
    }
}
