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
    public DiscoveredProject(
        string projectFilePath,
        IReadOnlyList<string> sourceFiles,
        IReadOnlyList<string> projectReferences,
        IReadOnlyList<string> references = null,
        string referenceSourcePath = null)
    {
        ProjectFilePath = projectFilePath;
        SourceFiles = sourceFiles;
        ProjectReferences = projectReferences;
        References = references ?? System.Array.Empty<string>();
        ReferenceSourcePath = referenceSourcePath;
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
}
