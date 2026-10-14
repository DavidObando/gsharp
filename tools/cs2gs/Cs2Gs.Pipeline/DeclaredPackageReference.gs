// <copyright file="DeclaredPackageReference.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

/// A build/dev-only `PackageReference` declared by the source C# project
/// (issue #2267) that must be preserved into the isolated `--via-sdk`
/// gsproj even though it contributes no compile-time reference DLL — e.g.
/// `Nerdbank.GitVersioning`, which is `PrivateAssets="all"` and ships
/// no `lib/` assembly, so (cref:SdkCompileRunner)'s reconstruction of
/// `PackageReference` items from the resolved compile-time reference set
/// ((cref:SdkCompileRunner.PartitionReferences)) can never recover it.
/// Without re-declaring it explicitly, the package's MSBuild targets never
/// import under `dotnet build` and its source generator (nbgv's
/// `ThisAssembly`) never runs. This type is intentionally generic — not
/// nbgv-specific — so other build-only/analyzer packages the source project
/// declares can be threaded through the same way.
class DeclaredPackageReference {
    /// Initializes a new instance of the (cref:DeclaredPackageReference) class.
    /// @param id The NuGet package id.
    /// @param version The concrete version to declare.
    /// @param privateAssets The `PrivateAssets` attribute value, or `null` to omit it.
    /// @param includeAssets The `IncludeAssets` attribute value, or `null` to omit it.
    init(id string, version string, privateAssets string? = nil, includeAssets string? = nil) {
        this.Id = id
        this.Version = version
        this.PrivateAssets = privateAssets
        this.IncludeAssets = includeAssets
    }

    /// Gets the NuGet package id.
    prop Id string {
        get;
    }

    /// Gets the concrete version to declare.
    prop Version string {
        get;
    }

    /// Gets the `PrivateAssets` attribute value, or `null` to omit it.
    prop PrivateAssets string? {
        get;
    }

    /// Gets the `IncludeAssets` attribute value, or `null` to omit it.
    prop IncludeAssets string? {
        get;
    }
}
