// <copyright file="ResxDesignerOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Resx;

/// <summary>
/// The inputs <see cref="ResxDesignerGenerator"/> needs beyond the parsed
/// <see cref="ResxDocument"/> itself (ADR-0142) — everything the real
/// <c>ResXFileCodeGenerator</c> / <c>PublicResXFileCodeGenerator</c> derives
/// from the owning MSBuild project (root namespace, resx-relative folder,
/// and the "Access Modifier" custom-tool choice).
/// </summary>
public sealed class ResxDesignerOptions
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ResxDesignerOptions"/> class.
    /// </summary>
    /// <param name="namespace">The package/namespace the generated class is declared in.</param>
    /// <param name="className">The generated class's simple name (the resx file's base name).</param>
    /// <param name="resourceManifestName">
    /// The manifest resource base name passed to <c>new ResourceManager(...)</c> —
    /// conventionally <c>{Namespace}.{ClassName}</c>, matching the name the
    /// resx's compiled <c>.resources</c> stream is embedded under.
    /// </param>
    /// <param name="isPublic">
    /// <see langword="true"/> for the <c>PublicResXFileCodeGenerator</c> "Public"
    /// custom tool (generated class is <c>public</c>); <see langword="false"/>
    /// for the default <c>ResXFileCodeGenerator</c> ("Internal", the common case).
    /// </param>
    public ResxDesignerOptions(string @namespace, string className, string resourceManifestName, bool isPublic)
    {
        this.Namespace = @namespace;
        this.ClassName = className;
        this.ResourceManifestName = resourceManifestName;
        this.IsPublic = isPublic;
    }

    /// <summary>Gets the package/namespace the generated class is declared in.</summary>
    public string Namespace { get; }

    /// <summary>Gets the generated class's simple name.</summary>
    public string ClassName { get; }

    /// <summary>Gets the manifest resource base name passed to <c>new ResourceManager(...)</c>.</summary>
    public string ResourceManifestName { get; }

    /// <summary>Gets a value indicating whether the generated class is <c>public</c> rather than <c>internal</c>.</summary>
    public bool IsPublic { get; }
}
