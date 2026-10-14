// <copyright file="Issue2345BclMisclassificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Microsoft.EntityFrameworkCore
import Microsoft.EntityFrameworkCore.Migrations
import System
import System.IO
import System.Linq
import Xunit

/// Issue #2345 follow-up: `ReferenceResolver.IsBclOrRuntimeAssemblyPath`
/// (the ADR-0084/#724 heuristic deciding whether the host's BCL/runtime
/// assemblies must be added to
/// (cref:ReferenceResolver.WithReferences(System.Collections.Generic.IEnumerable{string}))'s
/// user-visible reference set) used to classify by filename prefix alone, so
/// any assembly named `Microsoft.*` — including third-party NuGet
/// packages such as `Microsoft.EntityFrameworkCore.Relational`,
/// `Microsoft.Extensions.*`, `Microsoft.Data.Sqlite` — was
/// misclassified as "already BCL". When a caller's *only* references
/// happened to be such packages, the host BCL augmentation step was skipped
/// entirely, so core types like `System.Int32` never entered the
/// user-visible (cref:ReferenceResolver.Assemblies) index and could not
/// be resolved by name — surfacing later as an opaque
/// (cref:InvalidOperationException) ("Unable to project CLR type
/// 'System.Int32'") from (cref:ReferenceResolver.MapClrTypeToReferences(Type)).
///
/// The fix additionally requires a `Microsoft.*`-named path to reside
/// under a dotnet shared-framework or reference-pack directory (a `shared`
/// or `packs` path segment) before trusting it as BCL/runtime, while
/// still recognizing the unambiguous `System.*`/`mscorlib`/
/// `netstandard`/`WindowsBase` prefixes by name alone.
open class Issue2345BclMisclassificationTests {
    @Fact
    func RealMicrosoftPrefixedNuGetPackage_TriggersHostBclAugmentation() {
        // A genuine third-party NuGet package published under the
        // "Microsoft." prefix, restored from nuget.org (not a synthetic
        // stand-in) — the exact shape of the field-reported regression.
        let efRelationalPath = typeof(MigrationBuilder).Assembly.Location
        Assert.False(string.IsNullOrEmpty(efRelationalPath))
        Assert.Contains(
            "Microsoft.EntityFrameworkCore.Relational",
            Path.GetFileName(efRelationalPath),
            StringComparison.OrdinalIgnoreCase
        )
        using let resolver = ReferenceResolver.WithReferences([]string{efRelationalPath})
        // Before the fix: the sole reference "looked like BCL" by name alone,
        // so no host BCL augmentation happened and this failed.
        Assert.True(resolver.TryResolveType("System.Int32", out var intType))
        Assert.Equal("System.Int32", intType.FullName)
        // The user's own reference must still resolve, unaffected by the fix.
        Assert.True(
            resolver.TryResolveType(
                "Microsoft.EntityFrameworkCore.Migrations.MigrationBuilder",
                out var migrationBuilderType
            )
        )
        Assert.NotNull(migrationBuilderType)
        // Augmentation must have actually added host assemblies beyond the
        // single user-supplied one.
        Assert.True(
            resolver.Assemblies.Length > 1,
            "Expected host BCL/runtime assemblies to be augmented alongside the user's Microsoft.*-named NuGet package."
        )
    }

    @Fact
    func MultipleRealMicrosoftPrefixedNuGetPackages_StillTriggerHostBclAugmentation() {
        // Regression control: even when EVERY user reference is
        // Microsoft.*-named (so the old name-only heuristic would have
        // classified all of them as "already BCL"), augmentation must still
        // happen.
        let efRelationalPath = typeof(MigrationBuilder).Assembly.Location
        let efAbstractionsPath = typeof(DbContext).Assembly.Location
        Assert.False(string.IsNullOrEmpty(efRelationalPath))
        Assert.False(string.IsNullOrEmpty(efAbstractionsPath))
        using let resolver = ReferenceResolver.WithReferences([]string{efRelationalPath, efAbstractionsPath})
        Assert.True(resolver.TryResolveType("System.String", out var stringType))
        Assert.Equal("System.String", stringType.FullName)
    }

    @Fact
    func SyntheticMicrosoftPrefixedPackagePath_IsNotMisclassifiedAsBcl() {
        // A synthetic assembly, deliberately named with the "Microsoft."
        // prefix and placed under a directory structure mirroring a real
        // NuGet global-packages cache layout
        // ("packages/<id>/<version>/lib/<tfm>/...") rather than a dotnet
        // shared-framework or reference-pack directory. This isolates the
        // path-based classification itself from any particular real package.
        let packageDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2345Bcl",
            "packages",
            "microsoft.synthetic.fakepackage",
            "1.0.0",
            "lib",
            "net10.0"
        )
        Directory.CreateDirectory(packageDir)
        let syntheticPath = Path.Combine(packageDir, "Microsoft.Synthetic.FakePackage.dll")
        EmitTrivialLibrary(syntheticPath)
        using let resolver = ReferenceResolver.WithReferences([]string{syntheticPath})
        Assert.True(resolver.TryResolveType("System.Int32", out var intType))
        Assert.Equal("System.Int32", intType.FullName)
        Assert.True(
            resolver.Assemblies.Length > 1,
            "Expected host BCL/runtime assemblies to be augmented alongside the synthetic Microsoft.*-named package."
        )
    }

    @Fact
    func RealFrameworkMicrosoftAssembly_IsStillClassifiedAsBcl() {
        // Framework control: a genuine Microsoft.*-named runtime assembly
        // (Microsoft.CSharp.dll, shipped in the shared framework) must still
        // be recognized as BCL/runtime by path, preserving the pre-existing
        // "callers pinning a single BCL assembly get exactly that surface"
        // behavior (no augmentation) documented at the WithReferences call
        // site.
        let hostPaths = ReferenceResolver.HostTrustedPlatformAssemblyPaths()
        let microsoftCSharpPath string? = hostPaths.FirstOrDefault(
            (p string) -> string.Equals(Path.GetFileName(p), "Microsoft.CSharp.dll", StringComparison.OrdinalIgnoreCase)
        )
        Assert.False(
            string.IsNullOrEmpty(microsoftCSharpPath),
            "Expected the host's trusted platform assemblies to include Microsoft.CSharp.dll (shared-framework component) on a standard .NET install."
        )
        using let resolver = ReferenceResolver.WithReferences([]string{microsoftCSharpPath!!})
        // No augmentation: the sole reference is genuinely BCL/runtime, so
        // only it is loaded — matching pre-fix behavior for real framework
        // assemblies.
        Assert.Single(resolver.Assemblies)
    }

    @Fact
    func RealSystemPrefixedAssembly_IsStillClassifiedAsBclByNameAlone() {
        // The unambiguous "System.*" prefix must still be recognized without
        // requiring a shared/packs path (it is reserved by the runtime and
        // never legitimately used by third-party packages).
        let systemConsolePath = typeof(Console).Assembly.Location
        Assert.False(string.IsNullOrEmpty(systemConsolePath))
        using let resolver = ReferenceResolver.WithReferences([]string{systemConsolePath})
        Assert.Single(resolver.Assemblies)
    }

    shared {
        private func EmitTrivialLibrary(libraryPath string) {
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Synthetic

class Marker {
}`))){IsLibrary = true}
            using let peStream = File.Create(libraryPath)
            let result = library.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Microsoft.Synthetic.FakePackage"
            )
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
    }
}
