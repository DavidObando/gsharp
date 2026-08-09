// <copyright file="ResxCodeGenerator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;

namespace GSharp.Core.Resx;

/// <summary>
/// The top-level entry point consumers reach for (ADR-0142, issue #2200):
/// given a <c>.resx</c> file's path plus its owning project's root namespace
/// and root directory, computes the same namespace/class-name/manifest-name
/// convention MSBuild's default resx code generation uses, parses the resx,
/// and renders the generated G# designer source. Both the G# language server
/// (regenerating on save) and <c>cs2gs</c> (producing the codebehind for a
/// migrated <c>.resx</c> instead of translating <c>Resources.Designer.cs</c>)
/// call through this single class so the two integrations can never drift.
/// </summary>
public static class ResxCodeGenerator
{
    /// <summary>The conventional codebehind file suffix, mirroring C#'s <c>.Designer.cs</c>.</summary>
    public const string DesignerFileSuffix = ".Designer.gs";

    /// <summary>
    /// Computes the designer file path a given <c>.resx</c> file's generated
    /// class is conventionally written to: <c>{ResxBaseName}.Designer.gs</c>
    /// next to the resx, matching where VS places <c>Resources.Designer.cs</c>.
    /// </summary>
    /// <param name="resxPath">The absolute path to the <c>.resx</c> file.</param>
    /// <returns>The absolute path of the designer <c>.gs</c> file to write.</returns>
    public static string GetDesignerFilePath(string resxPath)
    {
        string directory = Path.GetDirectoryName(resxPath) ?? string.Empty;
        string baseName = Path.GetFileNameWithoutExtension(resxPath);
        return Path.Combine(directory, baseName + DesignerFileSuffix);
    }

    /// <summary>
    /// Generates the G# designer source for a <c>.resx</c> file, deriving the
    /// class's namespace from the project's root namespace plus the resx's
    /// folder path relative to the project root — the same convention MSBuild
    /// uses for the default (no <c>CustomToolNamespace</c> override) case.
    /// </summary>
    /// <param name="resxPath">The absolute path to the <c>.resx</c> file.</param>
    /// <param name="projectDirectory">The absolute path to the owning project's root directory.</param>
    /// <param name="rootNamespace">The owning project's root namespace (MSBuild <c>RootNamespace</c>).</param>
    /// <param name="isPublic">
    /// <see langword="true"/> to generate a <c>public</c> class (the
    /// <c>PublicResXFileCodeGenerator</c> custom tool); <see langword="false"/>
    /// for the default <c>internal</c> class.
    /// </param>
    /// <returns>The generated G# source text.</returns>
    public static string GenerateFromFile(string resxPath, string projectDirectory, string rootNamespace, bool isPublic = false)
    {
        if (resxPath is null)
        {
            throw new ArgumentNullException(nameof(resxPath));
        }

        ResxDocument document = ResxDocument.ParseFile(resxPath);
        string className = Path.GetFileNameWithoutExtension(resxPath);
        string @namespace = ComputeNamespace(resxPath, projectDirectory, rootNamespace);
        string manifestName = string.IsNullOrEmpty(@namespace) ? className : @namespace + "." + className;

        var options = new ResxDesignerOptions(@namespace, className, manifestName, isPublic);
        return ResxDesignerGenerator.Generate(document, options);
    }

    /// <summary>
    /// Computes the default resx codebehind namespace: the project's root
    /// namespace, plus one dotted segment per folder between the project
    /// directory and the resx file (e.g. <c>Properties/Resources.resx</c>
    /// under a project rooted at <c>Oahu.Core</c> yields
    /// <c>Oahu.Core.Properties</c>).
    /// </summary>
    private static string ComputeNamespace(string resxPath, string projectDirectory, string rootNamespace)
    {
        rootNamespace ??= string.Empty;
        if (string.IsNullOrEmpty(projectDirectory))
        {
            return rootNamespace;
        }

        string fullResxDir = Path.GetDirectoryName(Path.GetFullPath(resxPath)) ?? string.Empty;
        string fullProjectDir = Path.GetFullPath(projectDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        if (!fullResxDir.StartsWith(fullProjectDir, StringComparison.OrdinalIgnoreCase))
        {
            return rootNamespace;
        }

        string relative = fullResxDir.Substring(fullProjectDir.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (relative.Length == 0)
        {
            return rootNamespace;
        }

        string dotted = relative.Replace(Path.DirectorySeparatorChar, '.').Replace(Path.AltDirectorySeparatorChar, '.');
        return string.IsNullOrEmpty(rootNamespace) ? dotted : rootNamespace + "." + dotted;
    }
}
