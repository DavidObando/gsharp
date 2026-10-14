// <copyright file="ResxDesignerOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Resx

/// The inputs (cref:ResxDesignerGenerator) needs beyond the parsed
/// (cref:ResxDocument) itself (ADR-0142) — everything the real
/// `ResXFileCodeGenerator` / `PublicResXFileCodeGenerator` derives
/// from the owning MSBuild project (root namespace, resx-relative folder,
/// and the "Access Modifier" custom-tool choice).
class ResxDesignerOptions {
    /// Initializes a new instance of the (cref:ResxDesignerOptions) class.
    /// @param namespace The package/namespace the generated class is declared in.
    /// @param className The generated class's simple name (the resx file's base name).
    /// @param resourceManifestName The manifest resource base name passed to `new ResourceManager(...)` —
    /// conventionally `{Namespace}.{ClassName}`, matching the name the
    /// resx's compiled `.resources` stream is embedded under.
    /// @param isPublic `true` for the `PublicResXFileCodeGenerator` "Public"
    /// custom tool (generated class is `public`); `false`
    /// for the default `ResXFileCodeGenerator` ("Internal", the common case).
    init(namespace string, className string, resourceManifestName string, isPublic bool) {
        this.Namespace = namespace
        this.ClassName = className
        this.ResourceManifestName = resourceManifestName
        this.IsPublic = isPublic
    }

    /// Gets the package/namespace the generated class is declared in.
    prop Namespace string {
        get;
    }

    /// Gets the generated class's simple name.
    prop ClassName string {
        get;
    }

    /// Gets the manifest resource base name passed to `new ResourceManager(...)`.
    prop ResourceManifestName string {
        get;
    }

    /// Gets a value indicating whether the generated class is `public` rather than `internal`.
    prop IsPublic bool {
        get;
    }
}
