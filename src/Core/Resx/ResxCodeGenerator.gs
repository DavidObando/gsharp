// <copyright file="ResxCodeGenerator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Resx

import System
import System.IO

/// The top-level entry point consumers reach for (ADR-0142, issue #2200):
/// given a `.resx` file's path plus its owning project's root namespace
/// and root directory, computes the same namespace/class-name/manifest-name
/// convention MSBuild's default resx code generation uses, parses the resx,
/// and renders the generated G# designer source. Both the G# language server
/// (regenerating on save) and `cs2gs` (producing the codebehind for a
/// migrated `.resx` instead of translating `Resources.Designer.cs`)
/// call through this single class so the two integrations can never drift.
shared class ResxCodeGenerator {
    /// The conventional codebehind file suffix, mirroring C#'s `.Designer.cs`.
    const DesignerFileSuffix string = ".Designer.gs"

    /// Computes the designer file path a given `.resx` file's generated
    /// class is conventionally written to: `{ResxBaseName}.Designer.gs`
    /// next to the resx, matching where VS places `Resources.Designer.cs`.
    /// @param resxPath The absolute path to the `.resx` file.
    /// @returns The absolute path of the designer `.gs` file to write.
    func GetDesignerFilePath(resxPath string) string {
        let directory = Path.GetDirectoryName(resxPath) ?? string.Empty
        let baseName = Path.GetFileNameWithoutExtension(resxPath)
        return Path.Combine(directory, baseName + DesignerFileSuffix)
    }

    /// Generates the G# designer source for a `.resx` file, deriving the
    /// class's namespace from the project's root namespace plus the resx's
    /// folder path relative to the project root — the same convention MSBuild
    /// uses for the default (no `CustomToolNamespace` override) case.
    /// @param resxPath The absolute path to the `.resx` file.
    /// @param projectDirectory The absolute path to the owning project's root directory.
    /// @param rootNamespace The owning project's root namespace (MSBuild `RootNamespace`).
    /// @param isPublic `true` to generate a `public` class (the
    /// `PublicResXFileCodeGenerator` custom tool); `false`
    /// for the default `internal` class.
    /// @returns The generated G# source text.
    func GenerateFromFile(
        resxPath string?,
        projectDirectory string,
        rootNamespace string,
        isPublic bool = false
    ) string {
        if resxPath == nil {
            throw ArgumentNullException("resxPath")
        }
        let document = ResxDocument.ParseFile(resxPath)
        let className = Path.GetFileNameWithoutExtension(resxPath)
        let namespace = ComputeNamespace(resxPath, projectDirectory, rootNamespace)
        let manifestName = if string.IsNullOrEmpty(namespace) {
            className
        } else {
            namespace + "." + className
        }
        let options = ResxDesignerOptions(namespace, className, manifestName, isPublic)
        return ResxDesignerGenerator.Generate(document, options)
    }

    /// Computes the default resx codebehind namespace: the project's root
    /// namespace, plus one dotted segment per folder between the project
    /// directory and the resx file (e.g. `Properties/Resources.resx`
    /// under a project rooted at `Oahu.Core` yields
    /// `Oahu.Core.Properties`).
    private func ComputeNamespace(resxPath string, projectDirectory string, rootNamespace string?) string {
        var rootNamespace = rootNamespace
        rootNamespace ??= string.Empty
        if string.IsNullOrEmpty(projectDirectory) {
            return rootNamespace!!
        }
        let fullResxDir = Path.GetDirectoryName(Path.GetFullPath(resxPath)) ?? string.Empty
        let fullProjectDir = Path.GetFullPath(projectDirectory).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        )
        if !fullResxDir.StartsWith(fullProjectDir, StringComparison.OrdinalIgnoreCase) {
            return rootNamespace!!
        }
        let relative = fullResxDir.Substring(fullProjectDir.Length).TrimStart(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        )
        if relative.Length == 0 {
            return rootNamespace!!
        }
        let dotted = relative.Replace(Path.DirectorySeparatorChar, '.').Replace(Path.AltDirectorySeparatorChar, '.')
        return if string.IsNullOrEmpty(rootNamespace) {
            dotted
        } else {
            rootNamespace + "." + dotted
        }
    }
}
