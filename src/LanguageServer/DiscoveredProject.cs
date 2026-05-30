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
    public DiscoveredProject(string projectFilePath, IReadOnlyList<string> sourceFiles, IReadOnlyList<string> projectReferences)
    {
        ProjectFilePath = projectFilePath;
        SourceFiles = sourceFiles;
        ProjectReferences = projectReferences;
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
}
