// <copyright file="Adr0223HermeticReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// ADR-0223 D3: hermetic reference sets. (cref:ReferenceResolver.ForReferencePack) gives a
/// reference set that does not depend on the assemblies that the host process has loaded. A host
/// snapshot from (cref:ReferenceResolver.CaptureHostAssemblies) fixes the host assemblies of a
/// runtime resolver.
open class Adr0223HermeticReferenceTests {
    /// The pack resolver contains the reference pack and the bundled G# runtimes only. A type that only
    /// the test host has loaded does not resolve, and no type comes from a host fallback.
    @Fact
    func ForReferencePack_DoesNotSeeHostLoadedAssemblies() {
        const HostOnlyType = "Xunit.Assert"
        // Control: the default resolver is built from the host's loaded assemblies.
        using let hostResolver = ReferenceResolver.Default()
        Assert.True(hostResolver.TryResolveType(HostOnlyType, out _))
        let packDirectory = ReferenceResolver.FindReferencePackDirectory(CurrentTargetFramework, nil)
        using let resolver = ReferenceResolver.ForReferencePack(CurrentTargetFramework)
        Assert.False(resolver.TryResolveType(HostOnlyType, out _))
        Assert.False(resolver.TryResolveType(typeof(Adr0223HermeticReferenceTests).FullName!!, out _))
        Assert.True(resolver.TryResolveType("System.Object", out var objectType))
        Assert.False(resolver.IsHostFallback(objectType))
        let names = resolver.Assemblies.Select((a Assembly) -> a.GetName().Name).ToList()
        Assert.DoesNotContain("GSharp.Core.Tests", names)
        Assert.DoesNotContain("System.Private.CoreLib", names)
        Assert.Contains("System.Runtime", names)
        Assert.Contains("Gsharp.Extensions", names)
        Assert.Contains("Gsharp.Runtime.Channels", names)
        Assert.Contains("Gsharp.Runtime.Values", names)
        let packPrefix = packDirectory + Path.DirectorySeparatorChar
        let packAssemblies = resolver
            .Assemblies
            .Where(
            (a Assembly) -> ReferenceResolver.TryGetAssemblyPath(a, out var path) && path.StartsWith(
                packPrefix,
                StringComparison.Ordinal
            )
        )
            .ToList()
        Assert.NotEmpty(packAssemblies)
        Assert.Contains(packAssemblies, (a Assembly) -> a.GetName().Name == "System.Runtime")
    }

    /// An explicit pack root gives the same folder and the same assemblies as the discovered one.
    @Fact
    func ForReferencePack_ExplicitPackRoot_MatchesDiscoveredPack() {
        let discovered = ReferenceResolver.FindReferencePackDirectory(CurrentTargetFramework, nil)
        // <pack root>/<version>/ref/<tfm>
        let packRoot = Directory.GetParent(discovered)!!.Parent!!.Parent!!.FullName
        Assert.Equal(discovered, ReferenceResolver.FindReferencePackDirectory(CurrentTargetFramework, packRoot))
        using let fromDiscovery = ReferenceResolver.ForReferencePack(CurrentTargetFramework)
        using let fromRoot = ReferenceResolver.ForReferencePack(CurrentTargetFramework, packRoot)
        let Names = func (resolver ReferenceResolver) List[string] {
            return resolver
                .Assemblies
                .Select((a Assembly) -> a.GetName().FullName)
                .OrderBy((name string) -> name, StringComparer.Ordinal)
                .ToList()
        }
        let expected = Names(fromDiscovery)
        Assert.NotEmpty(expected)
        Assert.Equal(expected, Names(fromRoot))
    }

    /// The newest version of the framework that has the target folder wins, in semantic version
    /// order. Ordinal order would choose 10.0.9 over 10.0.10.
    @Fact
    func FindReferencePackDirectory_SelectsTheNewestVersionWithTheTargetFolder() {
        let root = Directory.CreateTempSubdirectory("adr0223_pack_").FullName
        try {
            for version in[]string{"9.0.20", "10.0.9", "10.0.10", "10.0.11-preview.1"} {
                let tfm = if version.StartsWith("9.", StringComparison.Ordinal) {
                    "net9.0"
                } else {
                    "net10.0"
                }
                Directory.CreateDirectory(Path.Combine(root, version, "ref", tfm))
            }
            // A newer version without the target folder is skipped.
            Directory.CreateDirectory(Path.Combine(root, "10.0.12", "ref", "net9.0"))
            Assert.Equal(
                Path.Combine(root, "10.0.11-preview.1", "ref", "net10.0"),
                ReferenceResolver.FindReferencePackDirectory("net10.0", root)
            )
            Directory.CreateDirectory(Path.Combine(root, "10.0.11", "ref", "net10.0"))
            Assert.Equal(
                Path.Combine(root, "10.0.11", "ref", "net10.0"),
                ReferenceResolver.FindReferencePackDirectory("net10.0", root)
            )
            Directory.Delete(Path.Combine(root, "10.0.11"), recursive: true)
            Directory.Delete(Path.Combine(root, "10.0.11-preview.1"), recursive: true)
            Assert.Equal(
                Path.Combine(root, "10.0.10", "ref", "net10.0"),
                ReferenceResolver.FindReferencePackDirectory("net10.0", root)
            )
            Assert.Equal(
                Path.Combine(root, "9.0.20", "ref", "net9.0"),
                ReferenceResolver.FindReferencePackDirectory("net9.0", root)
            )
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    /// A missing pack, an empty pack, and a moniker without a reference pack are errors. The factory
    /// does not fall back to the host's assemblies.
    @Fact
    func ForReferencePack_MissingPackOrUnsupportedMoniker_Throws() {
        let root = Directory.CreateTempSubdirectory("adr0223_nopack_").FullName
        try {
            let missing = Assert.Throws[DirectoryNotFoundException](
                () -> ReferenceResolver.ForReferencePack("net10.0", root)
            )
            Assert.Contains("net10.0", missing.Message)
            // A pack folder without assemblies is an error too, not an empty set that falls back to the host.
            Directory.CreateDirectory(Path.Combine(root, "10.0.1", "ref", "net10.0"))
            let empty = Assert.Throws[DirectoryNotFoundException](
                () -> ReferenceResolver.ForReferencePack("net10.0", root)
            )
            Assert.Contains("contains no assemblies", empty.Message)
            Assert.Throws[ArgumentException](() -> ReferenceResolver.ForReferencePack("netstandard2.0", root))
            Assert.Throws[ArgumentException](() -> ReferenceResolver.ForReferencePack("net48", root))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    /// The .NET root comes from DOTNET_ROOT first, then from each dotnet executable on the PATH. A
    /// symbolic link on the PATH resolves to the installation folder.
    @Fact
    func EnumerateDotnetRoots_UsesDotnetRootThenThePath() {
        let root = Directory.CreateTempSubdirectory("adr0223_roots_").FullName
        try {
            let executable = if OperatingSystem.IsWindows() {
                "dotnet.exe"
            } else {
                "dotnet"
            }
            let fromVariable = Path.Combine(root, "from-variable")
            let install = Path.Combine(root, "install")
            let noDotnet = Path.Combine(root, "no-dotnet")
            let linkFolder = Path.Combine(root, "bin")
            Directory.CreateDirectory(fromVariable)
            Directory.CreateDirectory(install)
            Directory.CreateDirectory(noDotnet)
            Directory.CreateDirectory(linkFolder)
            File.WriteAllText(Path.Combine(install, executable), string.Empty)
            var expectedFromPath = install
            if !OperatingSystem.IsWindows() {
                File.CreateSymbolicLink(Path.Combine(linkFolder, executable), Path.Combine(install, executable))
            } else {
                File.WriteAllText(Path.Combine(linkFolder, executable), string.Empty)
                expectedFromPath = linkFolder
            }
            let searchPath = string.Join(Path.PathSeparator, []string{noDotnet, linkFolder, install})
            let roots = ReferenceResolver.EnumerateDotnetRoots(fromVariable, searchPath)
            let expected = List[string]{fromVariable, expectedFromPath}
            if OperatingSystem.IsWindows() {
                expected.Add(install)
            }
            Assert.Equal(expected, roots)
            Assert.Empty(ReferenceResolver.EnumerateDotnetRoots(nil, noDotnet))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    /// A host snapshot fixes the host assemblies of a runtime resolver: an assembly that is not in the
    /// snapshot is not in the resolver, although the process has loaded it.
    @Fact
    func WithRuntimeReferences_HostSnapshot_FixesTheHostAssemblies() {
        let testAssembly = typeof(Adr0223HermeticReferenceTests).Assembly
        let snapshot = ReferenceResolver.CaptureHostAssemblies()
        Assert.Contains(snapshot, (a Assembly) -> a == testAssembly)
        let trimmed = snapshot.RemoveAll((a Assembly) -> a == testAssembly)
        using let fromSnapshot = ReferenceResolver.WithRuntimeReferences(nil, trimmed)
        Assert.DoesNotContain(fromSnapshot.Assemblies, (a Assembly) -> a == testAssembly)
        Assert.False(fromSnapshot.TryResolveType(typeof(Adr0223HermeticReferenceTests).FullName!!, out _))
        Assert.True(fromSnapshot.TryResolveType("System.Object", out _))
        // Control: without a snapshot, the resolver captures the loaded assemblies when the call runs.
        using let captured = ReferenceResolver.WithRuntimeReferences(nil, default(ImmutableArray[Assembly]))
        Assert.Contains(captured.Assemblies, (a Assembly) -> a == testAssembly)
    }

    shared {
        private let CurrentTargetFramework string = "net${Environment.Version.Major}.0"
    }
}
