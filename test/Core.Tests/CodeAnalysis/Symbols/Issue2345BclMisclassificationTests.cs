// <copyright file="Issue2345BclMisclassificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #2345 follow-up: <c>ReferenceResolver.IsBclOrRuntimeAssemblyPath</c>
/// (the ADR-0084/#724 heuristic deciding whether the host's BCL/runtime
/// assemblies must be added to <see cref="ReferenceResolver.WithReferences(System.Collections.Generic.IEnumerable{string})"/>'s
/// user-visible reference set) used to classify by filename prefix alone, so
/// any assembly named <c>Microsoft.*</c> — including third-party NuGet
/// packages such as <c>Microsoft.EntityFrameworkCore.Relational</c>,
/// <c>Microsoft.Extensions.*</c>, <c>Microsoft.Data.Sqlite</c> — was
/// misclassified as "already BCL". When a caller's *only* references
/// happened to be such packages, the host BCL augmentation step was skipped
/// entirely, so core types like <c>System.Int32</c> never entered the
/// user-visible <see cref="ReferenceResolver.Assemblies"/> index and could not
/// be resolved by name — surfacing later as an opaque
/// <see cref="InvalidOperationException"/> ("Unable to project CLR type
/// 'System.Int32'") from <see cref="ReferenceResolver.MapClrTypeToReferences(Type)"/>.
/// <para>
/// The fix additionally requires a <c>Microsoft.*</c>-named path to reside
/// under a dotnet shared-framework or reference-pack directory (a <c>shared</c>
/// or <c>packs</c> path segment) before trusting it as BCL/runtime, while
/// still recognizing the unambiguous <c>System.*</c>/<c>mscorlib</c>/
/// <c>netstandard</c>/<c>WindowsBase</c> prefixes by name alone.
/// </para>
/// </summary>
public class Issue2345BclMisclassificationTests
{
    [Fact]
    public void RealMicrosoftPrefixedNuGetPackage_TriggersHostBclAugmentation()
    {
        // A genuine third-party NuGet package published under the
        // "Microsoft." prefix, restored from nuget.org (not a synthetic
        // stand-in) — the exact shape of the field-reported regression.
        var efRelationalPath = typeof(Microsoft.EntityFrameworkCore.Migrations.MigrationBuilder).Assembly.Location;
        Assert.False(string.IsNullOrEmpty(efRelationalPath));
        Assert.Contains("Microsoft.EntityFrameworkCore.Relational", Path.GetFileName(efRelationalPath), StringComparison.OrdinalIgnoreCase);

        using var resolver = ReferenceResolver.WithReferences(new[] { efRelationalPath });

        // Before the fix: the sole reference "looked like BCL" by name alone,
        // so no host BCL augmentation happened and this failed.
        Assert.True(resolver.TryResolveType("System.Int32", out var intType));
        Assert.Equal("System.Int32", intType.FullName);

        // The user's own reference must still resolve, unaffected by the fix.
        Assert.True(resolver.TryResolveType("Microsoft.EntityFrameworkCore.Migrations.MigrationBuilder", out var migrationBuilderType));
        Assert.NotNull(migrationBuilderType);

        // Augmentation must have actually added host assemblies beyond the
        // single user-supplied one.
        Assert.True(resolver.Assemblies.Length > 1, "Expected host BCL/runtime assemblies to be augmented alongside the user's Microsoft.*-named NuGet package.");
    }

    [Fact]
    public void MultipleRealMicrosoftPrefixedNuGetPackages_StillTriggerHostBclAugmentation()
    {
        // Regression control: even when EVERY user reference is
        // Microsoft.*-named (so the old name-only heuristic would have
        // classified all of them as "already BCL"), augmentation must still
        // happen.
        var efRelationalPath = typeof(Microsoft.EntityFrameworkCore.Migrations.MigrationBuilder).Assembly.Location;
        var efAbstractionsPath = typeof(Microsoft.EntityFrameworkCore.DbContext).Assembly.Location;
        Assert.False(string.IsNullOrEmpty(efRelationalPath));
        Assert.False(string.IsNullOrEmpty(efAbstractionsPath));

        using var resolver = ReferenceResolver.WithReferences(new[] { efRelationalPath, efAbstractionsPath });

        Assert.True(resolver.TryResolveType("System.String", out var stringType));
        Assert.Equal("System.String", stringType.FullName);
    }

    [Fact]
    public void SyntheticMicrosoftPrefixedPackagePath_IsNotMisclassifiedAsBcl()
    {
        // A synthetic assembly, deliberately named with the "Microsoft."
        // prefix and placed under a directory structure mirroring a real
        // NuGet global-packages cache layout
        // ("packages/<id>/<version>/lib/<tfm>/...") rather than a dotnet
        // shared-framework or reference-pack directory. This isolates the
        // path-based classification itself from any particular real package.
        var packageDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2345Bcl",
            "packages",
            "microsoft.synthetic.fakepackage",
            "1.0.0",
            "lib",
            "net10.0");
        Directory.CreateDirectory(packageDir);

        var syntheticPath = Path.Combine(packageDir, "Microsoft.Synthetic.FakePackage.dll");
        EmitTrivialLibrary(syntheticPath);

        using var resolver = ReferenceResolver.WithReferences(new[] { syntheticPath });

        Assert.True(resolver.TryResolveType("System.Int32", out var intType));
        Assert.Equal("System.Int32", intType.FullName);
        Assert.True(resolver.Assemblies.Length > 1, "Expected host BCL/runtime assemblies to be augmented alongside the synthetic Microsoft.*-named package.");
    }

    [Fact]
    public void RealFrameworkMicrosoftAssembly_IsStillClassifiedAsBcl()
    {
        // Framework control: a genuine Microsoft.*-named runtime assembly
        // (Microsoft.CSharp.dll, shipped in the shared framework) must still
        // be recognized as BCL/runtime by path, preserving the pre-existing
        // "callers pinning a single BCL assembly get exactly that surface"
        // behavior (no augmentation) documented at the WithReferences call
        // site.
        var hostPaths = ReferenceResolver.HostTrustedPlatformAssemblyPaths();
        var microsoftCSharpPath = hostPaths.FirstOrDefault(p =>
            string.Equals(Path.GetFileName(p), "Microsoft.CSharp.dll", StringComparison.OrdinalIgnoreCase));

        Assert.False(string.IsNullOrEmpty(microsoftCSharpPath), "Expected the host's trusted platform assemblies to include Microsoft.CSharp.dll (shared-framework component) on a standard .NET install.");

        using var resolver = ReferenceResolver.WithReferences(new[] { microsoftCSharpPath });

        // No augmentation: the sole reference is genuinely BCL/runtime, so
        // only it is loaded — matching pre-fix behavior for real framework
        // assemblies.
        Assert.Single(resolver.Assemblies);
    }

    [Fact]
    public void RealSystemPrefixedAssembly_IsStillClassifiedAsBclByNameAlone()
    {
        // The unambiguous "System.*" prefix must still be recognized without
        // requiring a shared/packs path (it is reserved by the runtime and
        // never legitimately used by third-party packages).
        var systemConsolePath = typeof(Console).Assembly.Location;
        Assert.False(string.IsNullOrEmpty(systemConsolePath));

        using var resolver = ReferenceResolver.WithReferences(new[] { systemConsolePath });

        Assert.Single(resolver.Assemblies);
    }

    private static void EmitTrivialLibrary(string libraryPath)
    {
        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Synthetic

                class Marker {
                }
                """)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Microsoft.Synthetic.FakePackage");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
