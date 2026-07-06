// <copyright file="DiscoveredProject.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace GSharp.LanguageServer;

/// <summary>
/// Represents a discovered project with its source files.
/// </summary>
public sealed class DiscoveredProject
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DiscoveredProject"/> class.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <param name="sourceFiles">Absolute paths to all <c>.gs</c> source files in the project.</param>
    /// <param name="projectReferences">Absolute paths to referenced <c>.gsproj</c> files.</param>
    /// <param name="references">Absolute paths to assembly references (from the MSBuild-emitted response file).</param>
    /// <param name="referenceSourcePath">Absolute path to the <c>.rsp</c> the references were parsed from, or <c>null</c> when none was found.</param>
    /// <param name="assemblyName">The project's effective <c>AssemblyName</c> (i.e. the basename of the output DLL). Used by cross-project navigation to map an imported symbol's declaring assembly back to the owning project.</param>
    /// <param name="targetFramework">The project's target framework moniker (e.g. <c>net10.0</c>), parsed from the <c>.gsproj</c>; may be <c>null</c> when undeclared or unparseable.</param>
    /// <param name="rootNamespace">
    /// The project's effective <c>RootNamespace</c> (ADR-0142, issue #2200), used
    /// as the base namespace when generating a <c>.resx</c>'s codebehind class.
    /// Defaults to <see cref="AssemblyName"/> when undeclared, mirroring MSBuild.
    /// </param>
    public DiscoveredProject(
        string projectFilePath,
        IReadOnlyList<string> sourceFiles,
        IReadOnlyList<string> projectReferences,
        IReadOnlyList<string> references = null,
        string referenceSourcePath = null,
        string assemblyName = null,
        string targetFramework = null,
        string rootNamespace = null)
    {
        ProjectFilePath = projectFilePath;
        SourceFiles = sourceFiles;
        ProjectReferences = projectReferences;
        References = references ?? System.Array.Empty<string>();
        ReferenceSourcePath = referenceSourcePath;
        AssemblyName = assemblyName;
        TargetFramework = targetFramework;
        RootNamespace = rootNamespace;
    }

    /// <summary>
    /// Gets the absolute path to the <c>.gsproj</c> file.
    /// </summary>
    public string ProjectFilePath { get; }

    /// <summary>
    /// Gets the absolute paths to all <c>.gs</c> source files in the project.
    /// </summary>
    public IReadOnlyList<string> SourceFiles { get; }

    /// <summary>
    /// Gets the absolute paths to referenced <c>.gsproj</c> files.
    /// </summary>
    public IReadOnlyList<string> ProjectReferences { get; }

    /// <summary>
    /// Gets the absolute paths to assembly references (NuGet packages, transitive
    /// dependencies, and the ref-assembly outputs of non-G# <see cref="ProjectReferences"/>),
    /// parsed from the MSBuild-emitted response file. Empty when no <c>.rsp</c> has been
    /// produced yet (e.g. the project has never been built or restored).
    /// </summary>
    public IReadOnlyList<string> References { get; }

    /// <summary>
    /// Gets the absolute path to the <c>.rsp</c> file the references were parsed from,
    /// or <c>null</c> if no response file was located. The path is used by
    /// <see cref="ProjectState"/> to invalidate cached resolvers when the file is
    /// rewritten by a subsequent build.
    /// </summary>
    public string ReferenceSourcePath { get; }

    /// <summary>
    /// Gets the project's effective <c>AssemblyName</c> — the basename of the
    /// output DLL (without extension) the SDK will emit for this project. Used
    /// by cross-project Go-to-Definition (<c>WorkspaceState.TryGetProjectByOutputAssembly</c>)
    /// to map an imported symbol's declaring assembly back to the owning
    /// sibling project. May be <c>null</c> when the project file could not be
    /// parsed; in that case the consumer typically falls back to the project
    /// file's basename.
    /// </summary>
    public string AssemblyName { get; }

    /// <summary>
    /// Gets the project's target framework moniker (e.g. <c>net10.0</c>), parsed
    /// from the <c>.gsproj</c>'s <c>&lt;TargetFramework&gt;</c> (or raw
    /// <c>&lt;TargetFrameworks&gt;</c>) element. May be <c>null</c> or empty when
    /// neither is declared or the file could not be parsed. Surfaced to the VS Code
    /// Test Explorer so test groups can be labelled <c>&lt;project&gt; (&lt;tfm&gt;)</c>.
    /// </summary>
    public string TargetFramework { get; }

    /// <summary>
    /// Gets the project's effective <c>RootNamespace</c> (ADR-0142, issue #2200) —
    /// the base namespace the resx codebehind generator prefixes with the resx's
    /// folder path relative to the project root. Falls back to
    /// <see cref="AssemblyName"/> when the <c>.gsproj</c> declares no
    /// <c>&lt;RootNamespace&gt;</c>, matching MSBuild's own default.
    /// </summary>
    public string RootNamespace { get; }
}
