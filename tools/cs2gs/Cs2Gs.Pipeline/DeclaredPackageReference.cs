// <copyright file="DeclaredPackageReference.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.Pipeline;

/// <summary>
/// A build/dev-only <c>PackageReference</c> declared by the source C# project
/// (issue #2267) that must be preserved into the isolated <c>--via-sdk</c>
/// gsproj even though it contributes no compile-time reference DLL — e.g.
/// <c>Nerdbank.GitVersioning</c>, which is <c>PrivateAssets="all"</c> and ships
/// no <c>lib/</c> assembly, so <see cref="SdkCompileRunner"/>'s reconstruction of
/// <c>PackageReference</c> items from the resolved compile-time reference set
/// (<see cref="SdkCompileRunner.PartitionReferences"/>) can never recover it.
/// Without re-declaring it explicitly, the package's MSBuild targets never
/// import under <c>dotnet build</c> and its source generator (nbgv's
/// <c>ThisAssembly</c>) never runs. This type is intentionally generic — not
/// nbgv-specific — so other build-only/analyzer packages the source project
/// declares can be threaded through the same way.
/// </summary>
public sealed class DeclaredPackageReference
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DeclaredPackageReference"/> class.
    /// </summary>
    /// <param name="id">The NuGet package id.</param>
    /// <param name="version">The concrete version to declare.</param>
    /// <param name="privateAssets">The <c>PrivateAssets</c> attribute value, or <see langword="null"/> to omit it.</param>
    /// <param name="includeAssets">The <c>IncludeAssets</c> attribute value, or <see langword="null"/> to omit it.</param>
    public DeclaredPackageReference(string id, string version, string privateAssets = null, string includeAssets = null)
    {
        this.Id = id;
        this.Version = version;
        this.PrivateAssets = privateAssets;
        this.IncludeAssets = includeAssets;
    }

    /// <summary>Gets the NuGet package id.</summary>
    public string Id { get; }

    /// <summary>Gets the concrete version to declare.</summary>
    public string Version { get; }

    /// <summary>Gets the <c>PrivateAssets</c> attribute value, or <see langword="null"/> to omit it.</summary>
    public string PrivateAssets { get; }

    /// <summary>Gets the <c>IncludeAssets</c> attribute value, or <see langword="null"/> to omit it.</summary>
    public string IncludeAssets { get; }
}
